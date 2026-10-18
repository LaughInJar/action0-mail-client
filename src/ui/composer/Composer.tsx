import { useEffect, useMemo, useRef, useState } from "react";
import { useAccounts } from "../../accounts/context";
import { isValidAddress } from "../../core/addresses";
import type { AccountId } from "../../core/ids";
import { useDraftSync } from "../../data/drafts";
import { buildMailDocument } from "../../security/mailDocument";
import { useUi, useUiStore } from "../../state/context";
import type { ComposerSession, UiActions } from "../../state/uiStore";
import { formatBytes } from "../common/format";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { useFocusTrap } from "../common/useFocusTrap";
import { SafeHtmlFrame } from "../reader/SafeHtmlFrame";
import { AddressField } from "./AddressField";
import { COMPOSER_IDS } from "./ids";
import { RichTextEditor } from "./RichTextEditor";
import type { ComposeActions } from "./useComposeActions";

/** Props of {@link Composer}. */
export interface ComposerProps {
  readonly actions: ComposeActions;
  /** Tablets and phones: a full-screen, modal composer. */
  readonly fullScreen: boolean;
}

const TITLES: Readonly<Record<ComposerSession["kind"], string>> = {
  new: "New message",
  reply: "Reply",
  "reply-all": "Reply all",
  forward: "Forward",
  draft: "Draft",
};

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
  const title = session.subject.trim() || TITLES[session.kind];
  const composeAccounts = accounts.filter(
    (handle) => handle.provider.capabilities.compose,
  );

  const trySend = (skipSubjectCheck = false) => {
    const recipients = [...session.to, ...session.cc, ...session.bcc];
    const invalid = recipients.find((a) => !isValidAddress(a.address));
    if (recipients.length === 0) {
      setProblem("Add at least one recipient.");
      document.getElementById(COMPOSER_IDS.to)?.focus();
      return;
    }
    if (invalid) {
      setProblem(`“${invalid.address}” isn’t a valid address.`);
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

  const switchAccount = (accountId: AccountId) => {
    if (accountId === session.accountId) return;
    // The draft moves: delete it in the old account, save it in the new one.
    void sync
      .discard(key, session.accountId, session.draftId)
      .catch(() => undefined);
    const { draftId, ...rest } = session;
    store.getState().openComposer({
      ...rest,
      accountId,
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

  const saveStatus = session.saving
    ? "Saving…"
    : session.saveError !== undefined
      ? "Not saved"
      : session.savedRevision > 0 && session.savedRevision === session.revision
        ? "Saved"
        : "";

  const frame = fullScreen
    ? "fixed inset-0 z-50 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
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
            label="Close (keeps the draft)"
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
            Retry
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
            Send
          </button>
        ) : (
          <>
            <IconButton
              label={minimized ? "Restore" : "Minimize"}
              icon={minimized ? "chevron-up" : "minus"}
              onClick={() => {
                update({ window: minimized ? "docked" : "minimized" }, false);
              }}
            />
            <IconButton
              label={session.window === "expanded" ? "Smaller" : "Larger"}
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
              label="Close (Esc, keeps the draft)"
              icon="x"
              onClick={actions.close}
            />
          </>
        )}
      </header>

      {!minimized && (
        <>
          {composeAccounts.length > 1 && (
            <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1 dark:border-zinc-800">
              <label
                htmlFor="composer-from"
                className="w-8 shrink-0 text-sm text-zinc-500"
              >
                From
              </label>
              <select
                id="composer-from"
                value={session.accountId}
                onChange={(event) => {
                  switchAccount(event.target.value as AccountId);
                }}
                className="min-w-0 flex-1 bg-transparent py-1 text-sm pointer-coarse:min-h-11"
              >
                {composeAccounts.map(({ account }) => (
                  <option key={account.id} value={account.id}>
                    {account.email}
                  </option>
                ))}
              </select>
            </div>
          )}
          <AddressField
            id={COMPOSER_IDS.to}
            label="To"
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
                  Cc/Bcc
                </button>
              )
            }
          />
          {session.showCcBcc && (
            <>
              <AddressField
                id={COMPOSER_IDS.cc}
                label="Cc"
                accountId={session.accountId}
                value={session.cc}
                onChange={(cc) => {
                  update({ cc });
                }}
              />
              <AddressField
                id={COMPOSER_IDS.bcc}
                label="Bcc"
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
            aria-label="Subject"
            placeholder="Subject"
            value={session.subject}
            onChange={(event) => {
              update({ subject: event.target.value });
            }}
            className="shrink-0 border-b border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none dark:border-zinc-800 pointer-coarse:min-h-11"
          />
          <RichTextEditor
            initialHtml={session.body}
            focusOnOpen={initialFocus === "body"}
            onChange={(body) => {
              update({ body });
            }}
          />
          {session.quote && (
            <QuotedOriginal
              html={session.quote.html}
              kind={session.kind}
              onRemove={() => {
                const { quote, ...rest } = session;
                store.getState().openComposer({
                  ...rest,
                  forwarded: rest.forwarded.filter(
                    (p) => p.contentId === undefined,
                  ),
                  dirty: true,
                });
              }}
            />
          )}
          <ForwardedFiles
            session={session}
            onRemove={(index) => {
              update({
                forwarded: session.forwarded.filter((_, i) => i !== index),
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
              aria-label="Send without a subject?"
              className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-200 bg-amber-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-amber-950"
            >
              <span className="min-w-0 flex-1">Send without a subject?</span>
              <button
                type="button"
                ref={sendAnywayRef}
                onClick={() => {
                  setConfirmNoSubject(false);
                  trySend(true);
                }}
                className="rounded-md bg-blue-600 px-3 py-1 font-semibold text-white pointer-coarse:min-h-11"
              >
                Send anyway
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmNoSubject(false);
                  document.getElementById(COMPOSER_IDS.subject)?.focus();
                }}
                className="rounded-md px-3 py-1 hover:bg-amber-100 dark:hover:bg-amber-900 pointer-coarse:min-h-11"
              >
                Cancel
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
                Send
                <kbd className="ml-1 font-sans text-xs font-normal opacity-75 pointer-coarse:hidden">
                  Ctrl+Enter
                </kbd>
              </button>
            )}
            <div className="flex-1" />
            <IconButton
              label="Discard draft"
              icon="trash"
              onClick={actions.discard}
            />
          </footer>
        </>
      )}
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
  const what = kind === "forward" ? "forwarded message" : "quoted text";
  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Hide the ${what}` : `Show the ${what}`}
          title={open ? `Hide the ${what}` : `Show the ${what}`}
          onClick={() => {
            setOpen(!open);
          }}
          className="grid h-5 w-8 place-items-center rounded bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 pointer-coarse:h-11 pointer-coarse:w-14"
        >
          <Icon name="more" className="size-4" />
        </button>
        <span className="flex-1 text-xs text-zinc-500">
          {kind === "forward" ? "Forwarded message" : "Quoted text"}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
        >
          Remove
        </button>
      </div>
      {open && (
        <div className="mt-1.5 rounded border border-zinc-200 dark:border-zinc-800">
          <SafeHtmlFrame
            srcDoc={srcDoc}
            title={`The ${what}`}
            shortcuts={false}
          />
        </div>
      )}
    </div>
  );
}

/** Files of the original that a forward includes, removable. */
function ForwardedFiles({
  session,
  onRemove,
}: {
  session: ComposerSession;
  onRemove: (index: number) => void;
}) {
  const files = session.forwarded
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part.contentId === undefined);
  if (files.length === 0) return null;
  return (
    <ul
      aria-label="Attachments"
      className="flex shrink-0 flex-wrap gap-1.5 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800"
    >
      {files.map(({ part, index }) => (
        <li
          key={`${part.attachmentId}-${String(index)}`}
          className="flex max-w-full items-center gap-1.5 rounded-md border border-zinc-200 py-0.5 pr-0.5 pl-2 text-xs dark:border-zinc-700"
        >
          <Icon name="paperclip" className="size-3.5 shrink-0 text-zinc-500" />
          <span className="truncate">{part.filename}</span>
          <span className="shrink-0 text-zinc-500">
            {formatBytes(part.size)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${part.filename}`}
            onClick={() => {
              onRemove(index);
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
