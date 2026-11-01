import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AccountId, MessageId } from "../../core/ids";
import type { Message } from "../../core/model";
import { useInlineImages, useMessage } from "../../data/hooks";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { buildPrintableMail } from "../../security/printableMail";
import { sanitizeMailHtml } from "../../security/sanitize";
import { useUi, useUiStore } from "../../state/context";
import { loadsRemoteImages } from "../../state/settings";
import {
  displayName,
  displayNames,
  formatBytes,
  formatFullDate,
} from "../common/format";

/** Id of the print layout (`@media print` shows only it). */
export const PRINT_ROOT_ID = "print-root";

/** How long pictures may take to load before printing goes ahead without them. */
const IMAGE_WAIT_MS = 5000;

/**
 * The print layout of the job in the UI store: the subject, then every
 * message with its headers, text and attachments' names. Once everything
 * is loaded, it opens the platform's print dialog and clears the job.
 * Rendered at the end of `<body>`, shown only when printing.
 */
export function PrintHost() {
  const job = useUi((state) => state.printJob);
  const store = useUiStore();
  const platform = usePlatform();
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<ReadonlySet<string>>(new Set());
  /** The job whose dialog was opened (each is printed once). */
  const started = useRef<object | null>(null);

  // A new job starts over.
  const jobKey = job ? JSON.stringify([job.accountId, job.messageIds]) : "";
  const [shownKey, setShownKey] = useState(jobKey);
  if (shownKey !== jobKey) {
    setShownKey(jobKey);
    setReady(new Set());
  }

  const complete = job?.messageIds.every((id) => ready.has(id)) === true;

  useEffect(() => {
    if (!job || !complete || started.current === job) return;
    started.current = job;
    const root = rootRef.current;
    void (async () => {
      // Pictures first, so the printout has them.
      const images = root ? picturesIn(root) : [];
      await Promise.race([
        Promise.allSettled(
          images.map((image) =>
            // Not everywhere (test environments): then just go ahead.
            typeof image.decode === "function"
              ? image.decode()
              : Promise.resolve(),
          ),
        ),
        new Promise((resolve) => setTimeout(resolve, IMAGE_WAIT_MS)),
      ]);
      try {
        await platform.print(job.title || t.common.noSubject);
      } finally {
        if (store.getState().printJob === job)
          store.getState().setPrintJob(null);
      }
    })();
  }, [job, complete, platform, store, t]);

  if (!job) return null;
  return createPortal(
    <div
      id={PRINT_ROOT_ID}
      ref={rootRef}
      className="bg-white text-zinc-900"
      aria-hidden="true"
    >
      <h1 className="mb-4 text-xl font-semibold break-words">
        {job.title || t.common.noSubject}
      </h1>
      {job.messageIds.map((messageId) => (
        <PrintedMessage
          key={messageId}
          accountId={job.accountId}
          messageId={messageId}
          onReady={(id) => {
            setReady((current) =>
              current.has(id) ? current : new Set([...current, id]),
            );
          }}
        />
      ))}
    </div>,
    document.body,
  );
}

/** Every picture of the layout, also those inside the mails' shadow roots. */
function picturesIn(root: HTMLElement): HTMLImageElement[] {
  const images = [...root.querySelectorAll("img")];
  for (const host of root.querySelectorAll<HTMLElement>("[data-mail]"))
    images.push(...(host.shadowRoot?.querySelectorAll("img") ?? []));
  return images.filter((image) => image.getAttribute("src"));
}

function PrintedMessage({
  accountId,
  messageId,
  onReady,
}: {
  accountId: AccountId;
  messageId: MessageId;
  onReady: (id: MessageId) => void;
}) {
  const { data: message, isError } = useMessage(accountId, messageId);
  const { data: inlineImages, isLoading: imagesLoading } = useInlineImages(
    accountId,
    message,
  );
  const t = useT();
  const allowed = useUi(
    (state) =>
      state.remoteContentAllowed.has(messageId) ||
      loadsRemoteImages(state.settings, message?.from?.address),
  );
  const loaded =
    isError ||
    (message !== undefined &&
      (message.body.html === undefined || !imagesLoading));

  useEffect(() => {
    if (loaded) onReady(messageId);
  }, [loaded, messageId, onReady]);

  if (!message) return null;
  const files = message.attachments.filter(
    (attachment) => attachment.contentId === undefined,
  );
  return (
    <article className="mb-6 break-inside-auto border-t border-zinc-300 pt-3 first-of-type:border-t-0 first-of-type:pt-0">
      <dl className="mb-3 grid break-inside-avoid grid-cols-[auto_1fr] gap-x-3 text-sm">
        <Header label={t.common.from}>
          {formatAddress(message.from, t.common.unknownSender)}
        </Header>
        {message.to.length > 0 && (
          <Header label={t.common.to}>{list(message.to)}</Header>
        )}
        {message.cc.length > 0 && (
          <Header label={t.common.cc}>{list(message.cc)}</Header>
        )}
        <Header label={t.reader.date}>
          {formatFullDate(message.receivedAt, { locale: t.locale })}
        </Header>
        {message.subject && (
          <Header label={t.reader.subject}>{message.subject}</Header>
        )}
      </dl>
      <PrintedBody
        message={message}
        allowRemoteContent={allowed}
        inlineImages={inlineImages}
      />
      {files.length > 0 && (
        <p className="mt-3 text-sm text-zinc-600">
          {t.reader.attachments}:{" "}
          {files
            .map(
              (file) =>
                `${file.filename} (${formatBytes(file.size, t.locale)})`,
            )
            .join(", ")}
        </p>
      )}
    </article>
  );
}

const formatAddress = (address: Message["from"], unknown: string): string =>
  address
    ? address.name
      ? `${displayName(address, unknown)} <${address.address}>`
      : address.address
    : unknown;

const list = (addresses: Message["to"]) =>
  addresses.length > 0
    ? addresses
        .map((address) =>
          address.name
            ? `${address.name} <${address.address}>`
            : address.address,
        )
        .join(", ")
    : displayNames(addresses);

function Header({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="font-medium text-zinc-500">{label}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}

/** The mail's text: its HTML in a shadow root (its styles stay inside), or plain text. */
function PrintedBody({
  message,
  allowRemoteContent,
  inlineImages,
}: {
  message: Message;
  allowRemoteContent: boolean;
  inlineImages: Readonly<Record<string, string>> | undefined;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const html = message.body.html;
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || html === undefined) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = buildPrintableMail(sanitizeMailHtml(html).html, {
      allowRemoteContent,
      ...(inlineImages ? { inlineImages } : {}),
    });
  }, [html, allowRemoteContent, inlineImages]);
  if (html === undefined)
    return (
      <div className="text-sm whitespace-pre-wrap">
        {message.body.text ?? ""}
      </div>
    );
  return <div ref={hostRef} data-mail="" />;
}
