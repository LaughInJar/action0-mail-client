/** Helpers for showing and saving files in the browser. */

const urls = new Map<Blob, string>();

/**
 * An object URL for `blob`, created once and reused until
 * {@link releaseObjectUrls} frees it.
 */
export function objectUrl(blob: Blob): string {
  let url = urls.get(blob);
  if (url === undefined) {
    url = URL.createObjectURL(blob);
    urls.set(blob, url);
  }
  return url;
}

/** Frees the object URLs of these blobs. */
export function releaseObjectUrls(blobs: Iterable<Blob>): void {
  for (const blob of blobs) {
    const url = urls.get(blob);
    if (url === undefined) continue;
    URL.revokeObjectURL(url);
    urls.delete(blob);
  }
}

/** How an attachment opens. */
export type AttachmentKind = "image" | "pdf" | "download";

/** Image types that `<img>` shows safely (SVG included: no scripts in images). */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/svg+xml",
]);

/**
 * Images open in the viewer, PDFs in the browser's PDF viewer, everything
 * else (HTML, SVG documents, XML, …) only downloads.
 */
export function attachmentKind({
  mimeType,
  filename,
}: {
  readonly mimeType: string;
  readonly filename: string;
}): AttachmentKind {
  const type = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (IMAGE_TYPES.has(type)) return "image";
  if (
    type === "application/pdf" ||
    (type === "application/octet-stream" && /\.pdf$/i.test(filename))
  )
    return "pdf";
  return "download";
}

/** A short size like "3.2 MB" for messages about limits. */
export function megabytes(bytes: number, locale = "en-US"): string {
  const digits = bytes < 10 * 1024 * 1024 ? 1 : 0;
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(bytes / 1024 / 1024);
  return `${number} MB`;
}
