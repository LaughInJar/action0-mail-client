import { useMemo } from "react";
import { useAccountRegistry, useAccounts } from "../../accounts/context";
import { splitQuote, forwardQuote, replyQuote } from "../../compose/quote";
import { textToHtml } from "../../compose/html";
import {
  attachmentFromFile,
  mailHtmlToEditor,
  sentBytes,
} from "../../compose/session";
import { megabytes } from "../common/files";
import {
  attachmentOf,
  forwardSubject,
  replyRecipients,
  replySubject,
  threadingFor,
  type ReplyMode,
} from "../../core/compose";
import type { Draft } from "../../core/compose";
import type { AccountId, DraftId, MessageId } from "../../core/ids";
import type { Message } from "../../core/model";
import { referencedInlineImages } from "../../data/hooks";
import { useDraftSync, type DraftSync } from "../../data/drafts";
import { useRoute, useRouter, useUiStore } from "../../state/context";
import type {
  ComposerInit,
  ComposerSession,
  UiStore,
} from "../../state/uiStore";
import { errorMessage } from "../common/errorMessage";

/** How long a sent mail can be taken back. */
export const SEND_DELAY_MS = 30_000;

/** Starting, saving, sending and discarding mails. */
export interface ComposeActions {
  /** Whether the current account can write mail. */
  readonly canCompose: boolean;
  /** A new mail from the current account (or focuses the open composer). */
  readonly compose: () => void;
  readonly reply: (messageId: MessageId, mode: ReplyMode) => void;
  readonly forward: (messageId: MessageId) => void;
  /** Continues a draft (a message in the drafts mailbox). */
  readonly editDraft: (messageId: MessageId) => void;
  /** Continues a draft by its id (e.g. after a reload). */
  readonly resumeDraft: (draftId: DraftId) => void;
  /** Closes the composer; unsaved changes are saved. */
  readonly close: () => void;
  /** Deletes the draft and closes the composer (undoable). */
  readonly discard: () => void;
  /** Queues the mail for sending after {@link SEND_DELAY_MS}. */
  readonly send: () => void;
  /** Takes a queued mail back into the composer (the newest, by default). */
  readonly undoSend: (id?: number) => void;
  /** Sends a queued mail right away. */
  readonly sendNow: (id: number) => void;
  /** Brings a discarded draft back into the composer. */
  readonly restoreDraft: (session: ComposerSession) => void;
  /**
   * Attaches files to the open composer, or starts a new mail with them
   * (dropped on the app). Refuses, with a message, if they don't fit.
   */
  readonly attachFiles: (files: readonly File[]) => void;
}

/**
 * Saves the session if it has unsaved changes. Runs in the background (it
 * outlives the composer), reporting the result to the store.
 */
export function saveSession(
  store: UiStore,
  sync: DraftSync,
  session: ComposerSession,
): Promise<void> {
  if (session.revision <= session.savedRevision) return Promise.resolve();
  const { key, revision } = session;
  store.getState().markComposerSaving(key);
  return sync.save(key, session.accountId, session, session.draftId).then(
    ({ id }) => {
      store.getState().markComposerSaved(key, { revision, draftId: id });
    },
    (error: unknown) => {
      const message = errorMessage(error);
      store.getState().markComposerSaved(key, { error: message });
      if (store.getState().composer?.key !== key)
        store.getState().showToast({
          message: `Couldn’t save the draft: ${message}`,
          tone: "error",
        });
    },
  );
}

/** Sends a queued mail now (when its undo period ends, or on "Send now"). */
export function sendQueued(store: UiStore, sync: DraftSync, id: number): void {
  const pending = store.getState().takePendingSend(id);
  if (!pending) return;
  const { session } = pending;
  sync.send(session.key, session.accountId, session, session.draftId).then(
    () => {
      store.getState().showToast({ message: "Message sent", tone: "info" });
    },
    (error: unknown) => {
      store.getState().showToast({
        message: `Couldn’t send: ${errorMessage(error)} It’s in Drafts.`,
        tone: "error",
      });
    },
  );
}

/** {@link ComposeActions} for the current account. */
export function useComposeActions(): ComposeActions {
  const router = useRouter();
  const store = useUiStore();
  const registry = useAccountRegistry();
  const sync = useDraftSync();
  const accounts = useAccounts();
  const routeAccount = useRoute()?.accountId;
  const accountId = routeAccount ?? accounts[0]?.account.id;
  const canCompose =
    accounts.find((handle) => handle.account.id === accountId)?.provider
      .capabilities.compose === true;

  const actions = useMemo((): Omit<ComposeActions, "canCompose"> => {
    const currentAccount = (): AccountId | undefined =>
      router.getRoute()?.accountId ?? registry.list()[0]?.account.id;
    const canComposeIn = (accountId: AccountId | undefined) =>
      accountId !== undefined &&
      registry.get(accountId)?.provider.capabilities.compose === true;

    const fail = (prefix: string) => (error: unknown) => {
      store.getState().showToast({
        message: `${prefix}: ${errorMessage(error)}`,
        tone: "error",
      });
    };

    /** Opens a composer, saving the open one first. */
    const open = (init: ComposerInit) => {
      const current = store.getState().composer;
      if (current) void saveSession(store, sync, current);
      const session = store.getState().openComposer(init);
      // Load attachment bytes once; saves upload them again from memory.
      if (session.attachments.some((part) => !part.content)) {
        sync.loadParts(session.accountId, session.attachments).then(
          (attachments) => {
            store
              .getState()
              .updateComposer(session.key, { attachments }, false);
          },
          () => {
            // Each save fetches what's missing again (and reports failures).
          },
        );
      }
      return session;
    };

    /** The full message, then `start` with it. */
    const withMessage = (
      messageId: MessageId,
      action: string,
      start: (accountId: AccountId, message: Message) => void,
    ) => {
      const accountId = currentAccount();
      if (!canComposeIn(accountId) || accountId === undefined) return;
      sync
        .getMessage(accountId, messageId)
        .then((message) => {
          start(accountId, message);
        })
        .catch(fail(`Couldn’t ${action}`));
    };

    /** Shows a saved draft in the composer (or the open composer, if it's that draft). */
    const openDraft = (accountId: AccountId, draft: Draft) => {
      const current = store.getState().composer;
      if (current?.draftId === draft.id) {
        store
          .getState()
          .updateComposer(current.key, { window: "docked" }, false);
        return;
      }
      const { body, quote } = splitQuote(draft.html || textToHtml(draft.text));
      open({
        accountId,
        kind: "draft",
        draftId: draft.id,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        showCcBcc: draft.cc.length + draft.bcc.length > 0,
        subject: draft.subject,
        body: mailHtmlToEditor(body),
        ...(quote ? { quote } : {}),
        attachments: draft.attachments,
        ...(draft.threading ? { threading: draft.threading } : {}),
        focus: "body",
      });
    };

    return {
      compose: () => {
        const current = store.getState().composer;
        if (current) {
          store
            .getState()
            .updateComposer(
              current.key,
              { window: "docked", focus: "to" },
              false,
            );
          return;
        }
        const accountId = currentAccount();
        if (!canComposeIn(accountId) || accountId === undefined) return;
        open({ accountId, kind: "new", focus: "to" });
      },

      reply: (messageId, mode) => {
        withMessage(messageId, "reply", (accountId, message) => {
          const me = registry.get(accountId)?.account.email;
          const { to, cc } = replyRecipients(message, mode, me ? [me] : []);
          open({
            accountId,
            kind: mode,
            to,
            cc,
            showCcBcc: cc.length > 0,
            subject: replySubject(message.subject),
            quote: replyQuote(message),
            threading: threadingFor(message),
            focus: "body",
          });
        });
      },

      forward: (messageId) => {
        withMessage(messageId, "forward", (accountId, message) => {
          const inline = new Set(
            referencedInlineImages(message).map((image) => image.id),
          );
          open({
            accountId,
            kind: "forward",
            subject: forwardSubject(message.subject),
            quote: forwardQuote(message),
            attachments: message.attachments
              .filter(
                (part) => part.contentId === undefined || inline.has(part.id),
              )
              .map((part) => {
                const attachment = attachmentOf(message.id, part);
                if (inline.has(part.id)) return attachment;
                // A Content-ID that the body doesn't show makes it a file.
                const { contentId, ...file } = attachment;
                return file;
              }),
            threading: threadingFor(message),
            focus: "to",
          });
        });
      },

      editDraft: (messageId) => {
        const accountId = currentAccount();
        if (!canComposeIn(accountId) || accountId === undefined) return;
        sync
          .draftOf(accountId, messageId)
          .then((draft) => {
            openDraft(accountId, draft);
          })
          .catch(fail("Couldn’t open the draft"));
      },

      resumeDraft: (draftId) => {
        const accountId = currentAccount();
        if (!canComposeIn(accountId) || accountId === undefined) return;
        sync
          .getDraft(accountId, draftId)
          .then((draft) => {
            openDraft(accountId, draft);
          })
          .catch(fail("Couldn’t open the draft"));
      },

      close: () => {
        const current = store.getState().composer;
        if (!current) return;
        void saveSession(store, sync, current);
        store.getState().closeComposer(current.key);
      },

      discard: () => {
        const current = store.getState().composer;
        if (!current) return;
        store.getState().closeComposer(current.key);
        const hadContent =
          current.draftId !== undefined || current.revision > 0;
        sync
          .discard(current.key, current.accountId, current.draftId)
          .catch(fail("Couldn’t delete the draft"));
        if (hadContent) {
          const { draftId, ...rest } = current;
          store.getState().showToast({
            message: "Draft discarded",
            tone: "info",
            restoreDraft: rest,
          });
        }
      },

      send: () => {
        const current = store.getState().composer;
        if (!current) return;
        // Save right away, so the mail is a draft while it waits.
        if (current.revision > current.savedRevision)
          void sync
            .save(current.key, current.accountId, current, current.draftId)
            .catch(() => undefined);
        store.getState().queueSend(current.key, SEND_DELAY_MS);
      },

      undoSend: (id) => {
        const { pendingSends, composer } = store.getState();
        const pending =
          id === undefined
            ? pendingSends.at(-1)
            : pendingSends.find((p) => p.id === id);
        if (!pending || !store.getState().takePendingSend(pending.id)) return;
        if (composer) void saveSession(store, sync, composer);
        const { session } = pending;
        store.getState().openComposer({
          ...session,
          dirty: session.revision > session.savedRevision,
          focus: "body",
          window: "docked",
        });
      },

      sendNow: (id) => {
        sendQueued(store, sync, id);
      },

      attachFiles: (files) => {
        const current = store.getState().composer;
        const accountId = current?.accountId ?? currentAccount();
        if (
          files.length === 0 ||
          accountId === undefined ||
          !canComposeIn(accountId)
        )
          return;
        const max =
          registry.get(accountId)?.provider.capabilities.maxAttachmentBytes ??
          Number.POSITIVE_INFINITY;
        const total =
          (current ? sentBytes(current) : 0) +
          files.reduce((sum, file) => sum + file.size, 0);
        if (total > max) {
          store.getState().showToast({
            message: `Too big to attach: the mail would carry ${megabytes(total)}; the limit is ${megabytes(max)}.`,
            tone: "error",
          });
          return;
        }
        const added = files.map((file) => attachmentFromFile(file, false));
        if (current)
          store.getState().updateComposer(
            current.key,
            {
              attachments: [...current.attachments, ...added],
              window:
                current.window === "minimized" ? "docked" : current.window,
            },
            true,
          );
        else open({ accountId, kind: "new", attachments: added, focus: "to" });
      },

      restoreDraft: (session) => {
        const current = store.getState().composer;
        if (current) void saveSession(store, sync, current);
        store.getState().openComposer({
          ...session,
          dirty: true,
          focus: "body",
          window: "docked",
        });
      },
    };
  }, [registry, router, store, sync]);

  return useMemo(() => ({ ...actions, canCompose }), [actions, canCompose]);
}
