import type { Message } from "../../core/model";
import { referencedInlineImages } from "../../data/hooks";
import { formatBytes } from "../common/format";
import { Icon } from "../common/Icon";

/** Attachments of a message, except inline images that the body shows. */
export function AttachmentList({ message }: { message: Message }) {
  const inline = new Set(
    referencedInlineImages(message).map((attachment) => attachment.id),
  );
  const attachments = message.attachments.filter(
    (attachment) => !inline.has(attachment.id),
  );
  if (attachments.length === 0) return null;

  return (
    <section
      aria-label="Attachments"
      className="border-t border-zinc-200 px-4 py-4 sm:px-6 dark:border-zinc-800"
    >
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
        {attachments.length === 1
          ? "1 attachment"
          : `${attachments.length} attachments`}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <li
            key={attachment.id}
            title={`${attachment.filename} (${attachment.mimeType})`}
            className="flex max-w-full items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
          >
            <Icon name="paperclip" className="size-4 shrink-0 text-zinc-500" />
            <span className="min-w-0 truncate">{attachment.filename}</span>
            <span className="shrink-0 text-xs text-zinc-500">
              {formatBytes(attachment.size)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
