import { useEffect, useMemo, useRef, useState } from "react";
import { useAccounts } from "../../accounts/context";
import { isValidAddress } from "../../core/addresses";
import type { AccountId } from "../../core/ids";
import { useDraftSync } from "../../data/drafts";
import { buildMailDocument } from "../../security/mailDocument";
import { sanitizeMailHtml } from "../../security/sanitize";
import { fromAddress } from "../../core/compose";
import type { Sender } from "../../core/model";
import type { OutgoingAttachment } from "../../core/compose";
import { errorMessage } from "../common/errorMessage";
import { useSendersOf } from "../../data/senders";
import { useUi, useUiStore } from "../../state/context";
import type { ComposerSession, UiActions } from "../../state/uiStore";
import { formatBytes } from "../common/format";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { useFocusTrap } from "../common/useFocusTrap";
import { SafeHtmlFrame } from "../reader/SafeHtmlFrame";
import { AddressField } from "./AddressField";
import { sentBytes } from "../../compose/session";
import { megabytes } from "../common/files";
import { COMPOSER_IDS } from "./ids";
import { useComposerFiles } from "./useComposerFiles";
import { RichTextEditor } from "./RichTextEditor";
import type { ComposeActions } from "./useComposeActions";
import { useT } from "../../i18n/context";

/** Props of {@link Composer}. */
export interface ComposerProps {
  readonly actions: ComposeActions;
  /** Tablets and phones: a full-screen, modal composer. */
  readonly fullScreen: boolean;
}

/**
 * The open composer: docked at the bottom right on desktop (minimizable,
 * enlargeable), full screen elsewhere. Esc closes and keeps the draft,
 * Ctrl/⌘+Enter sends.
 */
export function Composer(props: ComposerProps) {
  const session = useUi((state) => state.composer);
  return session ? <ComposerWindow {...props} session={session} /> : null;
}

function ComposerWindow({
  actions,
  fullScreen,
  session,
}: ComposerProps & { readonly session: ComposerSession }) {
  const store = useUiStore();
  const sync = useDraftSync();
  const accounts = useAccounts();
  const rootRef = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmNoSubject, setConfirmNoSubject] = useState(false);
  const files = useComposerFiles(session, rootRef, setProblem);
  const pickerRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const c = t.composer;

  useFocusTrap(rootRef, fullScreen);
  // The first field to fill in: To for new mail, the text for replies.
  const [initialFocus] = useState(session.focus);
  useEffect(() => {
    if (initialFocus === "to")
      document.getElementById(COMPOSER_IDS.to)?.focus();
  }, [initialFocus]);
  const sendAnywayRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmNoSubject) sendAnywayRef.current?.focus();
  }, [confirmNoSubject]);

  const { key } = session;
  const update = (
    patch: Parameters<UiActions["updateComposer"]>[1],
    edit = true,
  ) => {
    store.getState().updateComposer(key, patch, edit);
  };
  const minimized = session.window === "minimized" && !fullScreen;
  const title = session.subject.trim() || c.titles[session.kind];
  const composeAccounts = accounts.filter(
    (handle) => handle.provider.capabilities.compose,
  );
  // Every address of every account that can write mail.
  const sendersByAccount = useSendersOf(
    composeAccounts.map((handle) => handle.account.id),
  );
  const fromChoices = composeAccounts.flatMap(
    ({
      account,
    }): {
      readonly accountId: AccountId;
      readonly sender: Sender;
    }[] => {
      const senders = sendersByAccount.get(account.id);
      return senders?.length
        ? senders.map((sender) => ({ accountId: account.id, sender }))
        : [
            {
              accountId: account.id,
              sender: {
                address: account.email,
                isDefault: true,
                signature: "",
              },
            },
          ];
    },
  );
  const fromValue = (accountId: AccountId, address: string) =>
    `${accountId} ${address.toLowerCase()}`;
  const currentFrom = fromValue(
    session.accountId,
    session.from?.address ??
      fromChoices.find(
        (choice) =>
          choice.accountId === session.accountId && choice.sender.isDefault,
      )?.sender.address ??
      "",
  );
  /** Sends from another address, or another account (the draft moves). */
  const chooseFrom = (accountId: AccountId, sender: Sender) => {
    const signature =
      session.signature === null
        ? null
        : { address: sender.address, html: sender.signature };
    if (accountId !== session.accountId) {
      switchAccount(accountId, { from: fromAddress(sender), signature });
      return;
    }
    update({ from: fromAddress(sender), signature });
  };

  const trySend = (skipSubjectCheck = false) => {
    const recipients = [...session.to, ...session.cc, ...session.bcc];
    const invalid = recipients.find((a) => !isValidAddress(a.address));
    if (recipients.length === 0) {
      setProblem(c.addRecipient);
      document.getElementById(COMPOSER_IDS.to)?.focus();
      return;
    }
    if (invalid) {
      setProblem(c.invalidAddress(invalid.address));
      return;
    }
    const bytes = sentBytes(session);
    if (bytes > files.maxBytes) {
      setProblem(
        c.tooBigToSend(
          megabytes(bytes, t.locale),
          megabytes(files.maxBytes, t.locale),
        ),
      );
      return;
    }
    if (!skipSubjectCheck && !session.subject.trim()) {
      setConfirmNoSubject(true);
      return;
    }
    setProblem(null);
    actions.send();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key === "Enter") {
      event.preventDefault();
      trySend();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (confirmNoSubject) setConfirmNoSubject(false);
      else actions.close();
    } else if (
      mod &&
      event.shiftKey &&
      ["c", "b"].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      update({ showCcBcc: true }, false);
      const field =
        event.key.toLowerCase() === "c" ? COMPOSER_IDS.cc : COMPOSER_IDS.bcc;
      requestAnimationFrame(() => document.getElementById(field)?.focus());
    }
  };

  // Keys for the whole composer. Listened for on the document, so fields
  // inside (suggestions, the link field) handle and stop them first.
  const onKeyDownRef = useRef(onKeyDown);
  useEffect(() => {
    onKeyDownRef.current = onKeyDown;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.target instanceof Node &&
        rootRef.current?.contains(event.target)
      )
        onKeyDownRef.current(event);
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
    };
  }, []);

  const switchAccount = (
    accountId: AccountId,
    sending: Pick<ComposerSession, "from" | "signature">,
  ) => {
    const from = session.accountId;
    if (accountId === from) return;
    const target = accounts.find((handle) => handle.account.id === accountId);
    const max =
      target?.provider.capabilities.maxAttachmentBytes ??
      Number.POSITIVE_INFINITY;
    if (sentBytes(session) > max) {
      setProblem(
        t.composer.tooBigForAccount(
          target?.account.email ?? "",
          megabytes(max, t.locale),
        ),
      );
      return;
    }
    // The draft moves: delete it in the old account, save it in the new one.
    const move = (loaded: readonly OutgoingAttachment[]) => {
      const current = store.getState().composer;
      // Closed, or moved elsewhere meanwhile.
      if (current?.key !== key || current.accountId !== from) return;
      void sync.discard(key, from, current.draftId).catch(() => undefined);
      const bytes = new Map(loaded.map((part) => [part.id, part.content]));
      const { draftId, ...rest } = current;
      store.getState().openComposer({
        ...rest,
        ...sending,
        accountId,
        // Parts of the old account's mail come along as bytes.
        attachments: rest.attachments.map((part) => {
          const content = part.content ?? bytes.get(part.id);
          return content ? { ...part, content } : part;
        }),
        ...(rest.threading
          ? {
              threading: {
                references: rest.threading.references,
                ...(rest.threading.inReplyTo
                  ? { inReplyTo: rest.threading.inReplyTo }
                  : {}),
              },
            }
          : {}),
        dirty: true,
      });
    };
    if (session.attachments.every((part) => part.content)) {
      move(session.attachments);
      return;
    }
    sync.loadParts(from, session.attachments).then(move, (error: unknown) => {
      setProblem(t.composer.couldntSave(errorMessage(error, t)));
    });
  };

  const saveStatus = session.saving
    ? t.common.saving
    : session.saveError !== undefined
      ? t.common.notSaved
      : session.savedRevision > 0 && session.savedRevision === session.revision
        ? t.common.saved
        : "";

  const frame = fullScreen
    ? "fixed inset-0 z-50 pt-[env(safe-area-inset-top)] pb-[var(--safe-bottom)]"
    : session.window === "expanded"
      ? "fixed inset-x-[6vw] inset-y-[5vh] z-40 rounded-lg border shadow-2xl"
      : minimized
        ? "fixed right-4 bottom-0 z-40 w-80 rounded-t-lg border border-b-0 shadow-xl"
        : "fixed right-4 bottom-0 z-40 h-[min(40rem,calc(100dvh-4rem))] w-[min(36rem,calc(100vw-2rem))] rounded-t-lg border border-b-0 shadow-2xl";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal={fullScreen}
      aria-label={title}
      data-own-keys=""
      tabIndex={-1}
      className={`${frame} flex flex-col border-zinc-300 bg-white text-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100`}
    >
      <header className="flex min-h-11 shrink-0 items-center gap-1 rounded-t-lg bg-zinc-100 px-2 dark:bg-zinc-900">
        {fullScreen && (
          <IconButton
            label={c.closeKeepsDraft}
            icon="arrow-left"
            onClick={actions.close}
          />
        )}
        {minimized ? (
          <button
            type="button"
            onClick={() => {
              update({ window: "docked" }, false);
            }}
            className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm font-semibold"
          >
            {title}
          </button>
        ) : (
          <h2 className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">
            {title}
          </h2>
        )}
        <span className="text-xs text-zinc-500" aria-live="polite">
          {saveStatus}
        </span>
        {session.saveError !== undefined && (
          <button
            type="button"
            title={session.saveError}
            onClick={() => {
              update({}, true);
            }}
            className="rounded px-1.5 text-xs font-medium text-blue-700 hover:bg-zinc-200 dark:text-blue-300 dark:hover:bg-zinc-800"
          >
            {c.retry}
          </button>
        )}
        {fullScreen ? (
          <button
            type="button"
            onClick={() => {
              trySend();
            }}
            className="ml-1 flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white pointer-coarse:min-h-11"
          >
            <Icon name="send" className="size-4" />
            {c.send}
          </button>
        ) : (
          <>
            <IconButton
              label={minimized ? c.restore : c.minimize}
              icon={minimized ? "chevron-up" : "minus"}
              onClick={() => {
                update({ window: minimized ? "docked" : "minimized" }, false);
              }}
            />
            <IconButton
              label={session.window === "expanded" ? c.smaller : c.larger}
              icon={session.window === "expanded" ? "minimize" : "maximize"}
              onClick={() => {
                update(
                  {
                    window:
                      session.window === "expanded" ? "docked" : "expanded",
                  },
                  false,
                );
              }}
            />
            <IconButton
              label={c.closeEscKeepsDraft}
              icon="x"
              onClick={actions.close}
            />
          </>
        )}
      </header>

      {!minimized && (
        <>
          {fromChoices.length > 1 && (
            <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1 dark:border-zinc-800">
              <label
                htmlFor="composer-from"
                className="w-8 shrink-0 text-sm text-zinc-500"
              >
                {t.common.from}
              </label>
              <select
                id="composer-from"
                value={currentFrom}
                onChange={(event) => {
                  const choice = fromChoices.find(
                    ({ accountId, sender }) =>
                      fromValue(accountId, sender.address) ===
                      event.target.value,
                  );
                  if (choice) chooseFrom(choice.accountId, choice.sender);
                }}
                className="min-w-0 flex-1 bg-transparent py-1 text-sm pointer-coarse:min-h-11"
              >
                {fromChoices.map(({ accountId, sender }) => (
                  <option
                    key={fromValue(accountId, sender.address)}
                    value={fromValue(accountId, sender.address)}
                  >
                    {sender.name
                      ? `${sender.name} <${sender.address}>`
                      : sender.address}
                  </option>
                ))}
              </select>
            </div>
          )}
          <AddressField
            id={COMPOSER_IDS.to}
            label={t.common.to}
            accountId={session.accountId}
            value={session.to}
            onChange={(to) => {
              setProblem(null);
              update({ to });
            }}
            trailing={
              !session.showCcBcc && (
                <button
                  type="button"
                  onClick={() => {
                    update({ showCcBcc: true }, false);
                    requestAnimationFrame(() =>
                      document.getElementById(COMPOSER_IDS.cc)?.focus(),
                    );
                  }}
                  className="shrink-0 rounded px-1.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
                >
                  {c.ccBcc}
                </button>
              )
            }
          />
          {session.showCcBcc && (
            <>
              <AddressField
                id={COMPOSER_IDS.cc}
                label={t.common.cc}
                accountId={session.accountId}
                value={session.cc}
                onChange={(cc) => {
                  update({ cc });
                }}
              />
              <AddressField
                id={COMPOSER_IDS.bcc}
                label={t.common.bcc}
                accountId={session.accountId}
                value={session.bcc}
                onChange={(bcc) => {
                  update({ bcc });
                }}
              />
            </>
          )}
          <input
            id={COMPOSER_IDS.subject}
            aria-label={c.subject}
            placeholder={c.subject}
            value={session.subject}
            onChange={(event) => {
              update({ subject: event.target.value });
            }}
            className="shrink-0 border-b border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none dark:border-zinc-800 pointer-coarse:min-h-11"
          />
          <RichTextEditor
            initialHtml={session.body}
            focusOnOpen={initialFocus === "body"}
            imageUrls={files.imageUrls}
            onFiles={(added) => files.addFiles(added, true)}
            onChange={(body) => {
              update({ body });
            }}
          />
          {session.signature?.html && (
            <SignatureBlock
              html={session.signature.html}
              onRemove={() => {
                update({ signature: null });
              }}
            />
          )}
          {session.quote && (
            <QuotedOriginal
              html={session.quote.html}
              kind={session.kind}
              onRemove={() => {
                // Inline images only the quote showed are left out when saving.
                const { quote, ...rest } = session;
                store.getState().openComposer({ ...rest, dirty: true });
              }}
            />
          )}
          <AttachedFiles
            session={session}
            onRemove={(id) => {
              update({
                attachments: session.attachments.filter((p) => p.id !== id),
              });
            }}
          />
          {problem && (
            <p
              role="alert"
              className="shrink-0 border-t border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {problem}
            </p>
          )}
          {confirmNoSubject && (
            <div
              role="alertdialog"
              aria-label={c.noSubjectAsk}
              className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-200 bg-amber-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-amber-950"
            >
              <span className="min-w-0 flex-1">{c.noSubjectAsk}</span>
              <button
                type="button"
                ref={sendAnywayRef}
                onClick={() => {
                  setConfirmNoSubject(false);
                  trySend(true);
                }}
                className="rounded-md bg-blue-600 px-3 py-1 font-semibold text-white pointer-coarse:min-h-11"
              >
                {c.sendAnyway}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmNoSubject(false);
                  document.getElementById(COMPOSER_IDS.subject)?.focus();
                }}
                className="rounded-md px-3 py-1 hover:bg-amber-100 dark:hover:bg-amber-900 pointer-coarse:min-h-11"
              >
                {t.common.cancel}
              </button>
            </div>
          )}
          <footer className="flex shrink-0 items-center gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
            {!fullScreen && (
              <button
                type="button"
                onClick={() => {
                  trySend();
                }}
                className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                <Icon name="send" className="size-4" />
                {c.send}
                <kbd className="ml-1 font-sans text-xs font-normal opacity-75 pointer-coarse:hidden">
                  {c.sendKey}
                </kbd>
              </button>
            )}
            <IconButton
              label={c.attachFiles}
              icon="paperclip"
              onClick={() => pickerRef.current?.click()}
            />
            <input
              ref={pickerRef}
              type="file"
              multiple
              hidden
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                files.addFiles(Array.from(event.target.files ?? []), false);
                event.target.value = "";
              }}
            />
            <div className="flex-1" />
            <IconButton
              label={c.discardDraft}
              icon="trash"
              onClick={actions.discard}
            />
          </footer>
          {files.dragOver && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-t-lg border-2 border-dashed border-blue-500 bg-blue-50/85 p-6 text-center text-sm font-medium text-blue-900 dark:bg-blue-950/85 dark:text-blue-100">
              {c.dropHint}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The signature, exactly as it will be sent (sandboxed, like a mail; your
 * own signature may show its images). Its text is edited in Settings.
 */
function SignatureBlock({
  html,
  onRemove,
}: {
  html: string;
  onRemove: () => void;
}) {
  const srcDoc = useMemo(
    () =>
      buildMailDocument(sanitizeMailHtml(html).html, {
        allowRemoteContent: true,
      }),
    [html],
  );
  const c = useT().composer;
  return (
    <div className="max-h-[30%] shrink-0 overflow-y-auto px-3 py-1.5">
      <div className="group/signature relative rounded border border-dashed border-zinc-300 dark:border-zinc-700">
        <SafeHtmlFrame srcDoc={srcDoc} title={c.signature} shortcuts={false} />
        <button
          type="button"
          aria-label={c.removeSignature}
          title={c.removeSignature}
          onClick={onRemove}
          className="absolute top-1 right-1 grid size-6 place-items-center rounded bg-white/90 text-zinc-500 shadow-sm hover:text-zinc-900 dark:bg-zinc-800/90 dark:text-zinc-300 dark:hover:text-white pointer-coarse:size-11"
        >
          <Icon name="x" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** The quoted original, collapsed by default; expanded it shows sandboxed. */
function QuotedOriginal({
  html,
  kind,
  onRemove,
}: {
  html: string;
  kind: ComposerSession["kind"];
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const srcDoc = useMemo(
    () => (open ? buildMailDocument(html, { allowRemoteContent: false }) : ""),
    [open, html],
  );
  const t = useT();
  const c = t.composer;
  const forward = kind === "forward";
  const toggle = open ? c.hideQuoted(forward) : c.showQuoted(forward);
  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={toggle}
          title={toggle}
          onClick={() => {
            setOpen(!open);
          }}
          className="grid h-5 w-8 place-items-center rounded bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 pointer-coarse:h-11 pointer-coarse:w-14"
        >
          <Icon name="more" className="size-4" />
        </button>
        <span className="flex-1 text-xs text-zinc-500">
          {c.quoted(forward)}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
        >
          {t.common.remove}
        </button>
      </div>
      {open && (
        <div className="mt-1.5 rounded border border-zinc-200 dark:border-zinc-800">
          <SafeHtmlFrame
            srcDoc={srcDoc}
            title={c.quotedFrame(forward)}
            shortcuts={false}
          />
        </div>
      )}
    </div>
  );
}

/** The mail's files (not the inline images), removable. */
function AttachedFiles({
  session,
  onRemove,
}: {
  session: ComposerSession;
  onRemove: (id: string) => void;
}) {
  const files = session.attachments.filter(
    (part) => part.contentId === undefined,
  );
  const t = useT();
  if (files.length === 0) return null;
  return (
    <ul
      aria-label={t.reader.attachments}
      className="flex max-h-28 shrink-0 flex-wrap gap-1.5 overflow-y-auto border-t border-zinc-200 px-3 py-2 dark:border-zinc-800"
    >
      {files.map((part) => (
        <li
          key={part.id}
          className="flex max-w-full items-center gap-1.5 rounded-md border border-zinc-200 py-0.5 pr-0.5 pl-2 text-xs dark:border-zinc-700"
        >
          <Icon name="paperclip" className="size-3.5 shrink-0 text-zinc-500" />
          <span className="truncate">{part.filename}</span>
          <span className="shrink-0 text-zinc-500">
            {formatBytes(part.size, t.locale)}
          </span>
          <button
            type="button"
            aria-label={t.composer.removeItem(part.filename)}
            onClick={() => {
              onRemove(part.id);
            }}
            className="grid size-6 shrink-0 place-items-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:size-9"
          >
            <Icon name="x" className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
