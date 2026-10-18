import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor,
} from "@tiptap/react";
import { Image, type ImageOptions } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";
import { DOMSerializer, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "../common/Icon";
import { useT } from "../../i18n/context";

/** An inline image to show at the drop or paste position. */
export interface InlineImageRef {
  readonly contentId: string;
  readonly alt: string;
}

/**
 * URLs that show the open composer's inline images, by Content-ID (there is
 * one composer at a time). Kept current by {@link RichTextEditor}.
 */
const shownImages = new Map<string, string>();

/**
 * Inline images that live in the mail as `cid:` references. Only such
 * images are accepted, so pasting from a web page never brings remote
 * images along; the editor shows them from in-memory files.
 */
const CidImage = Image.extend<ImageOptions>({
  addOptions() {
    return {
      inline: true,
      allowBase64: false,
      HTMLAttributes: {},
      resize: false,
    };
  },
  parseHTML() {
    return [{ tag: 'img[src^="cid:"]' }];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      // Rendered as data-cid: an <img src="cid:…"> in the page would try to
      // load it (ProseMirror draws plain images before node views are set).
      src: {
        default: null,
        parseHTML: (element) => element.getAttribute("src"),
        renderHTML: (attributes) => ({
          "data-cid": String(attributes.src ?? "").replace(/^cid:/, ""),
        }),
      },
    };
  },
  addNodeView() {
    return ({ node }) => {
      const image = document.createElement("img");
      image.className = "inline-block max-w-full align-bottom";
      const render = (current: ProseMirrorNode) => {
        const src = String(current.attrs.src ?? "");
        const contentId = src.startsWith("cid:") ? src.slice(4) : "";
        image.dataset.cid = contentId;
        image.alt = String(current.attrs.alt ?? "");
        const url = shownImages.get(contentId);
        if (url) image.src = url;
        else image.removeAttribute("src");
      };
      render(node);
      return {
        dom: image,
        update: (next) => {
          if (next.type !== node.type) return false;
          render(next);
          return true;
        },
      };
    };
  },
});

/**
 * The editor's HTML. Serialized in a detached document: elements created in
 * the page itself would start loading their `cid:` images.
 */
function editorHtml(editor: Editor): string {
  const inert = document.implementation.createHTMLDocument("");
  const container = inert.createElement("div");
  container.append(
    DOMSerializer.fromSchema(editor.schema).serializeFragment(
      editor.state.doc.content,
      { document: inert },
    ),
  );
  for (const image of container.querySelectorAll("img[data-cid]")) {
    image.setAttribute("src", `cid:${image.getAttribute("data-cid") ?? ""}`);
    image.removeAttribute("data-cid");
  }
  return container.innerHTML;
}

/** Puts inline images at `at` (or the closest text position). */
function insertImages(
  view: EditorView,
  at: number,
  images: readonly InlineImageRef[],
): void {
  const type = view.state.schema.nodes.image;
  if (!type || images.length === 0) return;
  const tr = view.state.tr;
  tr.setSelection(TextSelection.near(tr.doc.resolve(at)));
  for (const { contentId, alt } of images)
    tr.replaceSelectionWith(
      type.create({ src: `cid:${contentId}`, alt }),
      false,
    );
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** The document position under a drop (jsdom and some browsers can't tell). */
function dropPosition(view: EditorView, event: DragEvent): number {
  try {
    return (
      view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
      view.state.selection.from
    );
  } catch {
    return view.state.selection.from;
  }
}

/** DOM id of the editable message body. */
export const COMPOSER_BODY_ID = "composer-body";

/** Props of {@link RichTextEditor}. */
export interface RichTextEditorProps {
  /** Content when the editor is created (later changes come from the user). */
  readonly initialHtml: string;
  readonly onChange: (html: string) => void;
  /** Put the cursor into the text right away (at its start). */
  readonly focusOnOpen: boolean;
  /**
   * URLs that show inline images, by Content-ID. Without them (and
   * `onFiles`) the editor has no inline images (signatures).
   */
  readonly imageUrls?: Readonly<Record<string, string>>;
  /**
   * Files dropped or pasted into the text. Returns the images to show inline
   * there; the others became attachments (or nothing, if they don't fit).
   */
  readonly onFiles?: (files: readonly File[]) => readonly InlineImageRef[];
  /** DOM id of the text; defaults to {@link COMPOSER_BODY_ID}. */
  readonly id?: string;
  /** Accessible name of the text; "Message" by default. */
  readonly label?: string;
  /** "Write your message…" by default. */
  readonly placeholder?: string;
}

/**
 * The message text: basic rich text (bold, italic, underline, links,
 * lists, quotes) with a toolbar. Paragraphs show without margins, as they
 * will in the sent mail. Ctrl/⌘+K edits the link at the cursor.
 */
export function RichTextEditor({
  initialHtml,
  onChange,
  focusOnOpen,
  imageUrls,
  onFiles,
  id = COMPOSER_BODY_ID,
  label: labelProp,
  placeholder: placeholderProp,
}: RichTextEditorProps) {
  const texts = useT().composer.editor;
  const label = labelProp ?? texts.message;
  const placeholder = placeholderProp ?? texts.placeholder;
  const changed = useRef(onChange);
  const filesAdded = useRef(onFiles);
  useEffect(() => {
    changed.current = onChange;
    filesAdded.current = onFiles;
  });
  const [linking, setLinking] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        },
      }),
      Placeholder.configure({ placeholder }),
      CidImage,
    ],
    content: initialHtml,
    autofocus: focusOnOpen ? "start" : false,
    editorProps: {
      handleDrop: (view, event, _slice, moved) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        const add = filesAdded.current;
        if (moved || files.length === 0 || !add) return false;
        event.preventDefault();
        insertImages(view, dropPosition(view, event), add(files));
        return true;
      },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        const add = filesAdded.current;
        if (files.length === 0 || !add) return false;
        insertImages(view, view.state.selection.from, add(files));
        return true;
      },
      attributes: {
        id,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        class:
          "min-h-full px-4 py-3 text-sm leading-relaxed outline-none [&_a]:text-blue-700 [&_a]:underline dark:[&_a]:text-blue-300 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-600 dark:[&_blockquote]:text-zinc-400 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:m-0 [&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-zinc-400 [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&_ul]:list-disc [&_ul]:pl-6",
      },
    },
    onUpdate: ({ editor: current }) => {
      changed.current(editorHtml(current));
    },
  });

  // Images whose file loads later (reopened drafts, forwards) appear then.
  useEffect(() => {
    if (!imageUrls) return;
    shownImages.clear();
    for (const [contentId, url] of Object.entries(imageUrls))
      shownImages.set(contentId, url);
    const show = () => {
      for (const image of editor.view.dom.querySelectorAll<HTMLImageElement>(
        "img[data-cid]",
      )) {
        const url = imageUrls[image.dataset.cid ?? ""];
        if (url && image.getAttribute("src") !== url) image.src = url;
      }
    };
    if (editor.isInitialized) {
      show();
      return;
    }
    // The editor finishes setting up a moment after mounting.
    editor.on("create", show);
    return () => {
      editor.off("create", show);
    };
  }, [editor, imageUrls]);

  // The URLs belong to this editor's files; a later editor gets its own.
  const ownsImages = imageUrls !== undefined;
  useEffect(
    () => () => {
      if (ownsImages) shownImages.clear();
    },
    [ownsImages],
  );

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      setLinking(true);
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={onKeyDownCapture}
    >
      <Toolbar
        editor={editor}
        onLink={() => {
          setLinking(true);
        }}
      />
      {linking && (
        <LinkField
          editor={editor}
          onDone={() => {
            setLinking(false);
          }}
        />
      )}
      <EditorContent
        editor={editor}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      />
    </div>
  );
}

interface ToolProps {
  readonly label: string;
  readonly icon: IconName;
  readonly active?: boolean;
  readonly onClick: () => void;
}

function Tool({ label, icon, active, onClick }: ToolProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      // Keep the cursor (and selection) in the text.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onClick}
      className={`grid size-8 shrink-0 place-items-center rounded pointer-coarse:size-11 ${
        active
          ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100"
          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }`}
    >
      <Icon name={icon} className="size-4" />
    </button>
  );
}

function Toolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      underline: current.isActive("underline"),
      link: current.isActive("link"),
      bullets: current.isActive("bulletList"),
      numbers: current.isActive("orderedList"),
      quote: current.isActive("blockquote"),
    }),
  });
  const chain = () => editor.chain().focus();
  const texts = useT().composer.editor;
  return (
    <div
      role="toolbar"
      aria-label={texts.formatting}
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-zinc-200 px-2 py-1 dark:border-zinc-800"
    >
      <Tool
        label={texts.bold}
        icon="bold"
        active={state.bold}
        onClick={() => chain().toggleBold().run()}
      />
      <Tool
        label={texts.italic}
        icon="italic"
        active={state.italic}
        onClick={() => chain().toggleItalic().run()}
      />
      <Tool
        label={texts.underline}
        icon="underline"
        active={state.underline}
        onClick={() => chain().toggleUnderline().run()}
      />
      <Tool
        label={texts.link}
        icon="link"
        active={state.link}
        onClick={onLink}
      />
      <span className="mx-1 h-5 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700" />
      <Tool
        label={texts.bulleted}
        icon="list"
        active={state.bullets}
        onClick={() => chain().toggleBulletList().run()}
      />
      <Tool
        label={texts.numbered}
        icon="list-ordered"
        active={state.numbers}
        onClick={() => chain().toggleOrderedList().run()}
      />
      <Tool
        label={texts.quote}
        icon="quote"
        active={state.quote}
        onClick={() => chain().toggleBlockquote().run()}
      />
      <Tool
        label={texts.clear}
        icon="clear-format"
        onClick={() => chain().unsetAllMarks().clearNodes().run()}
      />
    </div>
  );
}

/** `https://` for bare domains, `mailto:` for addresses. */
function normalizeUrl(input: string): string {
  const url = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) return `mailto:${url}`;
  return `https://${url}`;
}

/** Inline field for the link at the cursor: Enter applies, Esc cancels. */
function LinkField({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const current = editor.getAttributes("link") as { href?: string };
  const [url, setUrl] = useState(current.href ?? "");
  const texts = useT().composer.editor;

  const apply = () => {
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!url.trim()) chain.unsetLink().run();
    else if (editor.state.selection.empty && !editor.isActive("link")) {
      const href = normalizeUrl(url);
      chain
        .insertContent({
          type: "text",
          text: url.trim(),
          marks: [{ type: "link", attrs: { href } }],
        })
        .run();
    } else chain.setLink({ href: normalizeUrl(url) }).run();
    onDone();
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
      <label htmlFor="composer-link" className="text-xs text-zinc-500">
        {texts.linkField}
      </label>
      <input
        id="composer-link"
        type="url"
        // The field opens on request; focusing it is what the user asked for.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        placeholder={texts.linkPlaceholder}
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            apply();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDone();
            editor.commands.focus();
          }
        }}
        className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 pointer-coarse:min-h-11"
      />
      <button
        type="button"
        onClick={apply}
        className="rounded px-2 py-1 text-sm font-medium text-blue-700 hover:bg-zinc-200 dark:text-blue-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
      >
        {url.trim() || !current.href ? texts.apply : texts.removeLink}
      </button>
    </div>
  );
}
