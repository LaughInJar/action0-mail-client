import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor,
} from "@tiptap/react";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "../common/Icon";

/** DOM id of the editable message body. */
export const COMPOSER_BODY_ID = "composer-body";

/** Props of {@link RichTextEditor}. */
export interface RichTextEditorProps {
  /** Content when the editor is created (later changes come from the user). */
  readonly initialHtml: string;
  readonly onChange: (html: string) => void;
  /** Put the cursor into the text right away (at its start). */
  readonly focusOnOpen: boolean;
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
}: RichTextEditorProps) {
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
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
      Placeholder.configure({ placeholder: "Write your message…" }),
    ],
    content: initialHtml,
    autofocus: focusOnOpen ? "start" : false,
    editorProps: {
      attributes: {
        id: COMPOSER_BODY_ID,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Message",
        class:
          "min-h-full px-4 py-3 text-sm leading-relaxed outline-none [&_a]:text-blue-700 [&_a]:underline dark:[&_a]:text-blue-300 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-600 dark:[&_blockquote]:text-zinc-400 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:m-0 [&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-zinc-400 [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&_ul]:list-disc [&_ul]:pl-6",
      },
    },
    onUpdate: ({ editor: current }) => {
      changed.current(current.getHTML());
    },
  });

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
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-zinc-200 px-2 py-1 dark:border-zinc-800"
    >
      <Tool
        label="Bold (Ctrl+B)"
        icon="bold"
        active={state.bold}
        onClick={() => chain().toggleBold().run()}
      />
      <Tool
        label="Italic (Ctrl+I)"
        icon="italic"
        active={state.italic}
        onClick={() => chain().toggleItalic().run()}
      />
      <Tool
        label="Underline (Ctrl+U)"
        icon="underline"
        active={state.underline}
        onClick={() => chain().toggleUnderline().run()}
      />
      <Tool
        label="Link (Ctrl+K)"
        icon="link"
        active={state.link}
        onClick={onLink}
      />
      <span className="mx-1 h-5 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700" />
      <Tool
        label="Bulleted list"
        icon="list"
        active={state.bullets}
        onClick={() => chain().toggleBulletList().run()}
      />
      <Tool
        label="Numbered list"
        icon="list-ordered"
        active={state.numbers}
        onClick={() => chain().toggleOrderedList().run()}
      />
      <Tool
        label="Quote"
        icon="quote"
        active={state.quote}
        onClick={() => chain().toggleBlockquote().run()}
      />
      <Tool
        label="Clear formatting"
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
        Link
      </label>
      <input
        id="composer-link"
        type="url"
        // The field opens on request; focusing it is what the user asked for.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        placeholder="https://… or an email address"
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
        {url.trim() || !current.href ? "Apply" : "Remove link"}
      </button>
    </div>
  );
}
