import { useMemo } from "react";
import { useAccountRegistry, useAccounts } from "../../accounts/context";
import { splitQuote, forwardQuote, replyQuote } from "../../compose/quote";
import { splitSignature } from "../../compose/signature";
import { textToHtml } from "../../compose/html";
import {
  attachmentFromFile,
  mailHtmlToEditor,
  sentBytes,
} from "../../compose/session";
import { megabytes } from "../common/files";
import {
  attachmentOf,
  defaultSender,
  forwardSubject,
  fromAddress,
  replyFrom,
  replyRecipients,
  replySubject,
  threadingFor,
  type ReplyMode,
} from "../../core/compose";
import type { Draft } from "../../core/compose";
import { parseMailto } from "../../core/mailto";
import type { AccountId, DraftId, MessageRef } from "../../core/ids";
import type { Message, Sender } from "../../core/model";
import { referencedInlineImages } from "../../data/hooks";
import { useDraftSync, type DraftSync } from "../../data/drafts";
import { useRoute, useRouter, useUi, useUiStore } from "../../state/context";
import type { Route } from "../../state/router";
import type {
  ComposerInit,
  ComposerSession,
  UiStore,
} from "../../state/uiStore";
import { errorMessage } from "../common/errorMessage";
import { useT, type I18n } from "../../i18n/context";

/** Starting, saving, sending and discarding mails. */
export interface ComposeActions {
  /** Whether a new mail can be written (see {@link compose}). */
  readonly canCompose: boolean;
  /** Whether mail can be written from an account (replies, drafts). */
  readonly canWriteFrom: (accountId: AccountId) => boolean;
  /**
   * A new mail (or focuses the open composer): from the current account,
   * or in All inboxes from the account the last mail went out from.
   */
  readonly compose: () => void;
  /**
   * A new mail filled in from a `mailto:` link (from the system, the tray
   * or a mail), from the account the last mail went out from; "" is an
   * empty one (like {@link compose}).
   */
  readonly composeFrom: (mailto: string) => void;
  /** Answers a message, from its account. */
  readonly reply: (message: MessageRef, mode: ReplyMode) => void;
  readonly forward: (message: MessageRef) => void;
  /** Continues a draft (a message in the drafts mailbox). */
  readonly editDraft: (message: MessageRef) => void;
  /** Continues a draft of an account by its id (e.g. after a reload). */
  readonly resumeDraft: (accountId: AccountId, draftId: DraftId) => void;
  /** Closes the composer; unsaved changes are saved. */
  readonly close: () => void;
  /** Deletes the draft and closes the composer (undoable). */
  readonly discard: () => void;
  /** Queues the mail for sending after the undo-send period (a setting). */
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
  t: I18n,
): Promise<void> {
  if (session.revision <= session.savedRevision) return Promise.resolve();
  const { key, revision, accountId } = session;
  store.getState().markComposerSaving(key);
  return sync.save(key, accountId, session, session.draftId).then(
    ({ id }) => {
      store
        .getState()
        .markComposerSaved(key, accountId, { revision, draftId: id });
    },
    (error: unknown) => {
      const message = errorMessage(error, t);
      store.getState().markComposerSaved(key, accountId, { error: message });
      if (store.getState().composer?.key !== key)
        store.getState().showToast({
          message: t.composer.couldntSave(message),
          tone: "error",
        });
    },
  );
}

/** Sends a queued mail now (when its undo period ends, or on "Send now"). */
export function sendQueued(
  store: UiStore,
  sync: DraftSync,
  id: number,
  t: I18n,
): void {
  const pending = store.getState().takePendingSend(id);
  if (!pending) return;
  const { session } = pending;
  sync.send(session.key, session.accountId, session, session.draftId).then(
    () => {
      store.getState().showToast({ message: t.composer.sent, tone: "info" });
    },
    (error: unknown) => {
      store.getState().showToast({
        message: t.composer.couldntSend(errorMessage(error, t)),
        tone: "error",
      });
    },
  );
}

/**
 * The account a new mail starts from: the account in context, but in All
 * inboxes the one the last mail went out from (if it can still write);
 * otherwise the first account that can.
 */
export function newMailAccount(
  route: Route,
  lastSend: string | undefined,
  accounts: readonly AccountId[],
  canCompose: (accountId: AccountId) => boolean,
): AccountId | undefined {
  const last = accounts.find((id) => id === lastSend);
  const preferred = route?.unified
    ? (last ?? route.accountId)
    : (route?.accountId ?? accounts[0]);
  if (preferred !== undefined && canCompose(preferred)) return preferred;
  // Inside one account that can't write: none. Otherwise the first that can.
  return route && !route.unified ? undefined : accounts.find(canCompose);
}

/** {@link ComposeActions} for the current account. */
export function useComposeActions(): ComposeActions {
  const router = useRouter();
  const store = useUiStore();
  const registry = useAccountRegistry();
  const sync = useDraftSync();
  const t = useT();
  const accounts = useAccounts();
  const route = useRoute();
  const lastSend = useUi((state) => state.settings.lastSendAccount);
  const accountId = newMailAccount(
    route,
    lastSend,
    accounts.map((handle) => handle.account.id),
    (id) =>
      accounts.find((handle) => handle.account.id === id)?.provider.capabilities
        .compose === true,
  );
  const canCompose = accountId !== undefined;

  const actions = useMemo((): Omit<ComposeActions, "canCompose"> => {
    const c = t.composer;
    const quoteTexts = {
      ...c.quote,
      locale: t.locale,
      unknownSender: t.common.unknownSender,
    };
    const canComposeIn = (accountId: AccountId | undefined) =>
      accountId !== undefined &&
      registry.get(accountId)?.provider.capabilities.compose === true;
    /** The account a new mail starts from (see {@link newMailAccount}). */
    const currentAccount = (): AccountId | undefined =>
      newMailAccount(
        router.getRoute(),
        store.getState().settings.lastSendAccount,
        registry.list().map((handle) => handle.account.id),
        canComposeIn,
      );

    const fail = (prefix: string) => (error: unknown) => {
      store.getState().showToast({
        message: `${prefix}: ${errorMessage(error, t)}`,
        tone: "error",
      });
    };

    /** Opens a composer, saving the open one first. */
    const open = (init: ComposerInit) => {
      const current = store.getState().composer;
      if (current) void saveSession(store, sync, current, t);
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

    /** The account's senders; none if they can't be loaded (mail still works). */
    const sendersOf = (accountId: AccountId) =>
      sync.senders(accountId).catch((): readonly Sender[] => []);

    /** From and signature of a composer that sends as `sender`. */
    const sendingAs = (sender: Sender | undefined) =>
      sender
        ? {
            from: fromAddress(sender),
            signature: { address: sender.address, html: sender.signature },
          }
        : {};

    /** The full message and its account's senders, then `start` with them. */
    const withMessage = (
      { accountId, messageId }: MessageRef,
      failure: string,
      start: (
        accountId: AccountId,
        message: Message,
        senders: readonly Sender[],
      ) => void,
    ) => {
      if (!canComposeIn(accountId)) return;
      Promise.all([sync.getMessage(accountId, messageId), sendersOf(accountId)])
        .then(([message, senders]) => {
          start(accountId, message, senders);
        })
        .catch(fail(failure));
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
      const split = splitQuote(draft.html || textToHtml(draft.text));
      const { quote } = split;
      const { body, signature } = splitSignature(split.body);
      open({
        accountId,
        kind: "draft",
        draftId: draft.id,
        ...(draft.from ? { from: draft.from } : {}),
        // No block in the draft: none, or the user removed it; keep it so.
        signature:
          signature === undefined
            ? null
            : { address: draft.from?.address ?? "", html: signature },
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

    /**
     * A new mail from `accountId` (or focuses the open composer, if there's
     * no content to fill in), with its default address and signature.
     */
    const startNew = (
      accountId: AccountId | undefined,
      content?: Partial<ComposerInit>,
    ) => {
      const current = store.getState().composer;
      if (current && !content) {
        store
          .getState()
          .updateComposer(
            current.key,
            { window: "docked", focus: "to" },
            false,
          );
        return;
      }
      if (!canComposeIn(accountId) || accountId === undefined) return;
      const session = open({ focus: "to", ...content, accountId, kind: "new" });
      // The default address and its signature, once known.
      void sendersOf(accountId).then((senders) => {
        const composer = store.getState().composer;
        if (composer?.key !== session.key || composer.signature !== undefined)
          return;
        store
          .getState()
          .updateComposer(
            session.key,
            sendingAs(defaultSender(senders)),
            false,
          );
      });
    };

    return {
      canWriteFrom: canComposeIn,

      compose: () => {
        startNew(currentAccount());
      },

      composeFrom: (mailto) => {
        const fields = parseMailto(mailto);
        const last = store.getState().settings.lastSendAccount as AccountId;
        const accountId = canComposeIn(last) ? last : currentAccount();
        if (!fields) {
          startNew(accountId);
          return;
        }
        startNew(accountId, {
          to: fields.to,
          cc: fields.cc,
          bcc: fields.bcc,
          showCcBcc: fields.cc.length + fields.bcc.length > 0,
          subject: fields.subject,
          ...(fields.body ? { body: textToHtml(fields.body) } : {}),
          focus: fields.to.length > 0 ? "body" : "to",
        });
      },

      reply: (original, mode) => {
        withMessage(original, c.couldntReply, (accountId, message, senders) => {
          const me = registry.get(accountId)?.account.email;
          const mine = [
            ...(me ? [me] : []),
            ...senders.map((sender) => sender.address),
          ];
          const { to, cc } = replyRecipients(message, mode, mine);
          open({
            accountId,
            kind: mode,
            ...sendingAs(replyFrom(message, senders)),
            to,
            cc,
            showCcBcc: cc.length > 0,
            subject: replySubject(message.subject),
            quote: replyQuote(message, quoteTexts),
            threading: threadingFor(message),
            focus: "body",
          });
        });
      },

      forward: (original) => {
        withMessage(
          original,
          c.couldntForward,
          (accountId, message, senders) => {
            const inline = new Set(
              referencedInlineImages(message).map((image) => image.id),
            );
            open({
              accountId,
              kind: "forward",
              ...sendingAs(replyFrom(message, senders)),
              subject: forwardSubject(message.subject),
              quote: forwardQuote(message, quoteTexts),
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
              threading: { ...threadingFor(message), forward: true },
              focus: "to",
            });
          },
        );
      },

      editDraft: ({ accountId, messageId }) => {
        if (!canComposeIn(accountId)) return;
        sync
          .draftOf(accountId, messageId)
          .then((draft) => {
            openDraft(accountId, draft);
          })
          .catch(fail(c.couldntOpenDraft));
      },

      resumeDraft: (accountId, draftId) => {
        if (!canComposeIn(accountId)) return;
        sync
          .getDraft(accountId, draftId)
          .then((draft) => {
            openDraft(accountId, draft);
          })
          .catch(fail(c.couldntOpenDraft));
      },

      close: () => {
        const current = store.getState().composer;
        if (!current) return;
        void saveSession(store, sync, current, t);
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
          .catch(fail(c.couldntDeleteDraft));
        if (hadContent) {
          const { draftId, ...rest } = current;
          store.getState().showToast({
            message: c.draftDiscarded,
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
        const { settings, queueSend, updateSettings } = store.getState();
        queueSend(current.key, settings.undoSendSeconds * 1000);
        // mailto: links write from the account used last.
        if (settings.lastSendAccount !== current.accountId)
          updateSettings({ lastSendAccount: current.accountId });
      },

      undoSend: (id) => {
        const { pendingSends, composer } = store.getState();
        const pending =
          id === undefined
            ? pendingSends.at(-1)
            : pendingSends.find((p) => p.id === id);
        if (!pending || !store.getState().takePendingSend(pending.id)) return;
        if (composer) void saveSession(store, sync, composer, t);
        const { session } = pending;
        store.getState().openComposer({
          ...session,
          dirty: session.revision > session.savedRevision,
          focus: "body",
          window: "docked",
        });
      },

      sendNow: (id) => {
        sendQueued(store, sync, id, t);
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
            message: c.tooBigToAttach(
              megabytes(total, t.locale),
              megabytes(max, t.locale),
            ),
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
        if (current) void saveSession(store, sync, current, t);
        store.getState().openComposer({
          ...session,
          dirty: true,
          focus: "body",
          window: "docked",
        });
      },
    };
  }, [registry, router, store, sync, t]);

  return useMemo(() => ({ ...actions, canCompose }), [actions, canCompose]);
}
