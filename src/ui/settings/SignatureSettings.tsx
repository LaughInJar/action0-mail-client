import { useEffect, useId, useRef, useState } from "react";
import { useAccounts } from "../../accounts/context";
import type { AccountHandle } from "../../accounts/types";
import { editorHtmlToMail, htmlToText } from "../../compose/html";
import { mailHtmlToEditor } from "../../compose/session";
import { isMailError } from "../../core/errors";
import type { Sender } from "../../core/model";
import { useSenders, useUpdateSignature } from "../../data/senders";
import { errorMessage } from "../common/errorMessage";
import { RichTextEditor } from "../composer/RichTextEditor";

/** Saves this long after the last keystroke. */
const SAVE_DELAY_MS = 1000;

/** Formatting the editor drops: inline styles, fonts, tables, pictures. */
const LOSSY = /\sstyle=|<font|<table|<img|\scolor=|\sface=|\ssize=/i;

/** Signatures of every account that has them, one editor per address. */
export function SignatureSettings() {
  const accounts = useAccounts().filter(
    (handle) => handle.provider.capabilities.senders,
  );
  if (accounts.length === 0) return null;
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium">Signatures</h4>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Added under what you write, above quoted mail. Saved to your account,
          so they also show up in Gmail.
        </p>
      </div>
      {accounts.map((handle) => (
        <AccountSignatures
          key={handle.account.id}
          handle={handle}
          showAccount={accounts.length > 1}
        />
      ))}
    </div>
  );
}

function AccountSignatures({
  handle,
  showAccount,
}: {
  handle: AccountHandle;
  showAccount: boolean;
}) {
  const { data: senders, isPending, error } = useSenders(handle.account.id);
  return (
    <div className="space-y-3">
      {showAccount && (
        <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
          {handle.account.email}
        </p>
      )}
      {isPending && (
        <p className="text-xs text-zinc-500">Loading signatures…</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          Couldn’t load the signatures: {errorMessage(error)}
        </p>
      )}
      {senders?.map((sender) => (
        <SignatureEditor key={sender.address} handle={handle} sender={sender} />
      ))}
    </div>
  );
}

type SaveState =
  | { readonly kind: "idle" | "saving" | "saved" }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly permission: boolean;
    };

/**
 * The signature of one address, saved to the account shortly after typing
 * stops (and when Settings closes). Without the permission to change
 * settings, saving offers "Allow editing", then saves what was typed.
 */
function SignatureEditor({
  handle,
  sender,
}: {
  handle: AccountHandle;
  sender: Sender;
}) {
  const editorId = useId();
  const { mutateAsync } = useUpdateSignature();
  const [initial] = useState(() => mailHtmlToEditor(sender.signature));
  const [lossy] = useState(() => LOSSY.test(sender.signature));
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const accountId = handle.account.id;

  const save = () => {
    clearTimeout(timer.current);
    const html = pending.current;
    if (html === null) return;
    pending.current = null;
    setState({ kind: "saving" });
    mutateAsync({ accountId, address: sender.address, html }).then(
      () => {
        setState({ kind: "saved" });
      },
      (error: unknown) => {
        // Keep what was typed, to save it once allowed.
        pending.current ??= html;
        setState({
          kind: "failed",
          message: errorMessage(error),
          permission: isMailError(error, "unavailable"),
        });
      },
    );
  };
  const latestSave = useRef(save);
  useEffect(() => {
    latestSave.current = save;
  });
  // Closing Settings saves what's still waiting.
  useEffect(
    () => () => {
      latestSave.current();
    },
    [],
  );

  const onChange = (editorHtml: string) => {
    const mail = editorHtmlToMail(editorHtml);
    pending.current = htmlToText(mail).trim() === "" ? "" : mail;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      latestSave.current();
    }, SAVE_DELAY_MS);
  };

  const allowEditing = () => {
    handle.auth.signIn({ askAgain: true }).then(
      () => {
        latestSave.current();
      },
      (error: unknown) => {
        setState({
          kind: "failed",
          message: errorMessage(error),
          permission: true,
        });
      },
    );
  };

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-sm">
        <span id={`${editorId}-label`} className="min-w-0 truncate">
          {sender.name ? `${sender.name} <${sender.address}>` : sender.address}
        </span>
        {sender.isDefault && (
          <span className="shrink-0 rounded bg-zinc-100 px-1.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            default
          </span>
        )}
        <span
          role="status"
          className="ml-auto shrink-0 text-xs text-zinc-500 dark:text-zinc-400"
        >
          {state.kind === "saving" && "Saving…"}
          {state.kind === "saved" && "Saved"}
        </span>
      </div>
      {lossy && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          This signature has formatting the editor can’t keep (colours, fonts,
          sizes, tables or pictures). Editing it here removes that formatting;
          to keep it, edit it in Gmail.
        </p>
      )}
      <div className="flex h-36 flex-col overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
        <RichTextEditor
          id={editorId}
          label={`Signature for ${sender.address}`}
          placeholder="No signature"
          initialHtml={initial}
          focusOnOpen={false}
          onChange={onChange}
        />
      </div>
      {state.kind === "failed" && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-x-2 text-xs text-red-700 dark:text-red-400"
        >
          <span>Not saved: {state.message}</span>
          {state.permission ? (
            <button
              type="button"
              onClick={allowEditing}
              className="rounded px-1.5 py-0.5 font-semibold text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-500/15 pointer-coarse:min-h-11"
            >
              Allow editing
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                latestSave.current();
              }}
              className="rounded px-1.5 py-0.5 font-semibold text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-500/15 pointer-coarse:min-h-11"
            >
              Try again
            </button>
          )}
        </p>
      )}
    </div>
  );
}
