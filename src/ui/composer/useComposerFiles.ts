import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useAccounts } from "../../accounts/context";
import { attachmentFromFile, sentBytes } from "../../compose/session";
import { useUiStore } from "../../state/context";
import type { ComposerSession } from "../../state/uiStore";
import {
  attachmentKind,
  megabytes,
  objectUrl,
  releaseObjectUrls,
} from "../common/files";
import type { InlineImageRef } from "./RichTextEditor";

/** What {@link useComposerFiles} offers the composer. */
export interface ComposerFiles {
  /**
   * Adds files; with `inline`, images become inline images (returned, for
   * the editor to place) and other files attachments. Nothing is added if
   * the mail would get too big; then `onProblem` explains.
   */
  readonly addFiles: (
    files: readonly File[],
    inline: boolean,
  ) => readonly InlineImageRef[];
  /** Files are being dragged over the composer. */
  readonly dragOver: boolean;
  /** URLs that show the inline images, by Content-ID. */
  readonly imageUrls: Readonly<Record<string, string>>;
  /** The account's limit for attachments (bytes). */
  readonly maxBytes: number;
}

const hasFiles = (event: DragEvent) => {
  // Synthetic drag events (tests, some browsers' internal drags) may lack types.
  const types: readonly string[] | undefined = event.dataTransfer?.types;
  return types?.includes("Files") === true;
};

/**
 * Files in the composer: adding them (picker, drop, paste) within the
 * provider's size limit, and showing inline images from memory.
 */
export function useComposerFiles(
  session: ComposerSession,
  rootRef: RefObject<HTMLElement | null>,
  onProblem: (problem: string | null) => void,
): ComposerFiles {
  const store = useUiStore();
  const accounts = useAccounts();
  const maxBytes =
    accounts.find((handle) => handle.account.id === session.accountId)?.provider
      .capabilities.maxAttachmentBytes ?? Number.POSITIVE_INFINITY;

  const addFiles = (
    files: readonly File[],
    inline: boolean,
  ): readonly InlineImageRef[] => {
    const current = store.getState().composer;
    if (current?.key !== session.key || files.length === 0) return [];
    const total =
      sentBytes(current) + files.reduce((sum, file) => sum + file.size, 0);
    if (total > maxBytes) {
      onProblem(
        `With ${files.length === 1 ? "this file" : "these files"} the mail would carry ${megabytes(total)} of attachments; the limit is ${megabytes(maxBytes)}.`,
      );
      return [];
    }
    onProblem(null);
    const added = files.map((file) =>
      attachmentFromFile(
        file,
        inline &&
          attachmentKind({ mimeType: file.type, filename: file.name }) ===
            "image",
      ),
    );
    store
      .getState()
      .updateComposer(
        current.key,
        { attachments: [...current.attachments, ...added] },
        true,
      );
    return added.flatMap((part) =>
      part.contentId === undefined
        ? []
        : [{ contentId: part.contentId, alt: part.filename }],
    );
  };

  // Dropping and pasting files anywhere on the composer (the text handles
  // its own, for inline images). Native listeners: the composer is a dialog.
  const [dragOver, setDragOver] = useState(false);
  const added = useRef(addFiles);
  useEffect(() => {
    added.current = addFiles;
  });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let depth = 0;
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth++;
      setDragOver(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setDragOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (event.defaultPrevented || files.length === 0) return;
      event.preventDefault();
      added.current(files, false);
    };
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (event.defaultPrevented || files.length === 0) return;
      event.preventDefault();
      added.current(files, false);
    };
    root.addEventListener("dragenter", onDragEnter);
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragleave", onDragLeave);
    root.addEventListener("drop", onDrop);
    root.addEventListener("paste", onPaste);
    return () => {
      root.removeEventListener("dragenter", onDragEnter);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("dragleave", onDragLeave);
      root.removeEventListener("drop", onDrop);
      root.removeEventListener("paste", onPaste);
    };
  }, [rootRef]);

  // Inline images show from memory; their URLs are freed with the composer.
  const { attachments } = session;
  const imageUrls = useMemo(() => {
    const urls: Record<string, string> = {};
    for (const part of attachments)
      if (part.contentId !== undefined && part.content)
        urls[part.contentId] = objectUrl(part.content);
    return urls;
  }, [attachments]);
  const shown = useRef<readonly Blob[]>([]);
  useEffect(() => {
    shown.current = attachments.flatMap((part) =>
      part.content ? [part.content] : [],
    );
  }, [attachments]);
  useEffect(
    () => () => {
      releaseObjectUrls(shown.current);
    },
    [],
  );

  return { addFiles, dragOver, imageUrls, maxBytes };
}
