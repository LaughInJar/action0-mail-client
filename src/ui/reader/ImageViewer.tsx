import { useEffect, useRef, useState } from "react";
import type { AttachmentInfo } from "../../core/model";
import { errorMessage } from "../common/errorMessage";
import { objectUrl, releaseObjectUrls } from "../common/files";
import { Icon } from "../common/Icon";
import { useFocusTrap } from "../common/useFocusTrap";
import { useT } from "../../i18n/context";

/** Props of {@link ImageViewer}. */
export interface ImageViewerProps {
  /** The message's image attachments, in order. */
  readonly images: readonly AttachmentInfo[];
  readonly index: number;
  readonly load: (image: AttachmentInfo) => Promise<Blob>;
  readonly onIndex: (index: number) => void;
  readonly onDownload: (image: AttachmentInfo) => void;
  readonly onClose: () => void;
}

/** Shown state of the current image. */
type Shown =
  | { readonly id: string; readonly url: string }
  | { readonly id: string; readonly error: string };

/**
 * Full-window viewer for a message's images: ← / → between them, Esc
 * closes. Images show as `<img>` from memory, so even SVGs can't run code.
 */
export function ImageViewer({
  images,
  index,
  load,
  onIndex,
  onDownload,
  onClose,
}: ImageViewerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const image = images[index];
  const [shown, setShown] = useState<Shown | null>(null);
  const loaded = useRef(new Set<Blob>());
  useFocusTrap(rootRef, true, undefined, { focusContainer: true });

  useEffect(() => {
    if (!image) return;
    let current = true;
    load(image).then(
      (blob) => {
        // Shown as the image type it claims; `<img>` never runs scripts.
        const typed =
          blob.type === image.mimeType
            ? blob
            : new Blob([blob], { type: image.mimeType });
        loaded.current.add(typed);
        if (current) setShown({ id: image.id, url: objectUrl(typed) });
      },
      (error: unknown) => {
        if (current) setShown({ id: image.id, error: errorMessage(error, t) });
      },
    );
    return () => {
      current = false;
    };
  }, [image, load, t]);

  useEffect(() => {
    const blobs = loaded.current;
    return () => {
      releaseObjectUrls(blobs);
    };
  }, []);

  const step = (delta: number) => {
    if (images.length > 1)
      onIndex((index + delta + images.length) % images.length);
  };
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
      else return;
      event.preventDefault();
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      keys.current(event);
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
    };
  }, []);

  if (!image) return null;
  const current = shown?.id === image.id ? shown : null;
  const button =
    "grid size-10 shrink-0 place-items-center rounded-full text-white hover:bg-white/15 pointer-coarse:size-12";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={image.filename}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] focus:outline-none"
    >
      <header className="flex shrink-0 items-center gap-2 px-3 py-2 text-sm text-white">
        <span className="min-w-0 flex-1 truncate font-medium">
          {image.filename}
        </span>
        {images.length > 1 && (
          <span className="shrink-0 text-white/70">
            {t.reader.imageOf(index + 1, images.length)}
          </span>
        )}
        <button
          type="button"
          aria-label={t.reader.downloadFile(image.filename)}
          title={t.reader.download}
          onClick={() => {
            onDownload(image);
          }}
          className={button}
        >
          <Icon name="download" className="size-5" />
        </button>
        <button
          type="button"
          aria-label={t.reader.closeViewer}
          title={t.reader.closeViewer}
          onClick={onClose}
          className={button}
        >
          <Icon name="x" className="size-5" />
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {current === null && (
          <p className="text-sm text-white/70">{t.common.loading}</p>
        )}
        {current && "error" in current && (
          <p role="alert" className="text-sm text-white">
            {current.error}
          </p>
        )}
        {current && "url" in current && (
          <img
            src={current.url}
            alt={image.filename}
            className="max-h-full max-w-full object-contain"
          />
        )}
        {images.length > 1 && (
          <>
            <button
              type="button"
              aria-label={t.reader.previousImage}
              onClick={() => {
                step(-1);
              }}
              className={`${button} absolute top-1/2 left-2 -translate-y-1/2 bg-black/40`}
            >
              <Icon name="chevron-left" className="size-6" />
            </button>
            <button
              type="button"
              aria-label={t.reader.nextImage}
              onClick={() => {
                step(1);
              }}
              className={`${button} absolute top-1/2 right-2 -translate-y-1/2 bg-black/40`}
            >
              <Icon name="chevron-right" className="size-6" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
