import { useState } from "react";
import type { AccountId } from "../../core/ids";
import type { AttachmentInfo, Message } from "../../core/model";
import { referencedInlineImages, useFetchAttachment } from "../../data/hooks";
import { useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { attachmentKind } from "../common/files";
import { usePlatform } from "../../platform/context";
import { formatBytes } from "../common/format";
import { Icon, type IconName } from "../common/Icon";
import { ImageViewer } from "./ImageViewer";
import { useT } from "../../i18n/context";

const KIND_ICONS: Readonly<
  Record<ReturnType<typeof attachmentKind>, IconName>
> = {
  image: "image",
  pdf: "file",
  download: "paperclip",
};

/**
 * Attachments of a message, except inline images that the body shows.
 * Images open in the viewer, PDFs in the browser's PDF viewer (new tab),
 * everything else downloads; each one also has a Download button.
 */
export function AttachmentList({
  accountId,
  message,
}: {
  accountId: AccountId;
  message: Message;
}) {
  const fetchFile = useFetchAttachment();
  const t = useT();
  const platform = usePlatform();
  const store = useUiStore();
  const [viewing, setViewing] = useState<number | null>(null);
  const inline = new Set(
    referencedInlineImages(message).map((attachment) => attachment.id),
  );
  const attachments = message.attachments.filter(
    (attachment) => !inline.has(attachment.id),
  );
  const images = attachments.filter((a) => attachmentKind(a) === "image");
  if (attachments.length === 0) return null;

  const load = (attachment: AttachmentInfo) =>
    fetchFile(accountId, message.id, attachment.id);
  const failed = (attachment: AttachmentInfo) => (error: unknown) => {
    store.getState().showToast({
      message: t.reader.couldntOpen(
        attachment.filename,
        errorMessage(error, t),
      ),
      tone: "error",
    });
  };
  const download = (attachment: AttachmentInfo) => {
    load(attachment).then((blob) => {
      platform.saveFile(blob, attachment.filename).catch(failed(attachment));
    }, failed(attachment));
  };
  const openPdf = (attachment: AttachmentInfo) => {
    // Started inside the click (popup blockers), handed the file once loaded.
    const show = platform.openFileLater();
    load(attachment).then(
      (blob) => {
        show({ blob, name: attachment.filename, type: "application/pdf" });
      },
      (error: unknown) => {
        show(null);
        failed(attachment)(error);
      },
    );
  };
  const open = (attachment: AttachmentInfo) => {
    switch (attachmentKind(attachment)) {
      case "image":
        setViewing(images.indexOf(attachment));
        break;
      case "pdf":
        openPdf(attachment);
        break;
      case "download":
        download(attachment);
        break;
    }
  };

  return (
    <section
      aria-label={t.reader.attachments}
      className="border-t border-zinc-200 px-4 py-4 sm:px-6 dark:border-zinc-800"
    >
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
        {t.reader.attachmentCount(attachments.length)}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {attachments.map((attachment) => {
          const kind = attachmentKind(attachment);
          return (
            <li
              key={attachment.id}
              className="flex max-w-full items-center rounded-lg border border-zinc-200 text-sm dark:border-zinc-700"
            >
              <button
                type="button"
                title={`${attachment.filename} (${attachment.mimeType})`}
                aria-label={
                  kind === "download"
                    ? t.reader.downloadFile(attachment.filename)
                    : t.reader.openFile(attachment.filename)
                }
                onClick={() => {
                  open(attachment);
                }}
                className="flex min-w-0 items-center gap-2 rounded-l-lg py-2 pr-2 pl-3 hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
              >
                <Icon
                  name={KIND_ICONS[kind]}
                  className="size-4 shrink-0 text-zinc-500"
                />
                <span className="min-w-0 truncate">{attachment.filename}</span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {formatBytes(attachment.size, t.locale)}
                </span>
              </button>
              {kind !== "download" && (
                <button
                  type="button"
                  aria-label={t.reader.downloadFile(attachment.filename)}
                  title={t.reader.download}
                  onClick={() => {
                    download(attachment);
                  }}
                  className="grid size-9 shrink-0 place-items-center rounded-r-lg border-l border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:size-11"
                >
                  <Icon name="download" className="size-4" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {viewing !== null && images[viewing] && (
        <ImageViewer
          images={images}
          index={viewing}
          load={load}
          onIndex={setViewing}
          onDownload={download}
          onClose={() => {
            setViewing(null);
          }}
        />
      )}
    </section>
  );
}
