/** Building blocks of the Add account wizard's steps. */
import { useState, type ReactNode } from "react";
import { useT } from "../../i18n/context";
import { Icon } from "../common/Icon";

export const PRIMARY_BUTTON =
  "w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 pointer-coarse:min-h-11";

export function StepFrame({
  titleId,
  title,
  onBack,
  children,
}: {
  titleId: string;
  title: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  const a = useT().accounts;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {onBack && (
          <button
            type="button"
            aria-label={a.back}
            onClick={onBack}
            className="grid size-8 place-items-center rounded-md text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:size-11"
          >
            <Icon name="arrow-left" className="size-4" />
          </button>
        )}
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

export function ErrorNote({
  message,
  id,
}: {
  message: string | undefined;
  id?: string;
}) {
  if (message === undefined) return null;
  return (
    <p id={id} role="alert" className="text-sm text-red-700 dark:text-red-400">
      {message}
    </p>
  );
}

export function HelpItem({
  term,
  children,
}: {
  term: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="font-medium">{term}</dt>
      <dd className="text-zinc-600 dark:text-zinc-400">{children}</dd>
    </div>
  );
}

export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-700 underline underline-offset-2 dark:text-blue-300"
    >
      {children}
    </a>
  );
}

/** A value to enter elsewhere (this app's origin, a redirect URI), with a copy button. */
export function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const canCopy = "clipboard" in navigator;
  const a = useT().accounts;
  return (
    <span className="my-1.5 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
        {value}
      </code>
      {canCopy && (
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => {
                setCopied(true);
              },
              () => {
                setCopied(false);
              },
            );
          }}
          className="shrink-0 rounded px-2 py-1 text-xs font-medium text-blue-700 hover:bg-zinc-100 dark:text-blue-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
        >
          {copied ? a.copied : a.copy}
        </button>
      )}
    </span>
  );
}
