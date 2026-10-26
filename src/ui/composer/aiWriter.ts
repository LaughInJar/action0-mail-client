/**
 * The AI writing into the composer's editor: its text replaces a range
 * (the selection, or the whole draft) as it arrives, without filling the
 * undo history; once it's done the whole change is one undo step. The text
 * is built as nodes, never parsed as HTML.
 */
import type { Editor } from "@tiptap/core";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

/** What the AI's text goes in place of. */
export interface WriteTarget {
  /** Write a text (the draft is empty), rewrite the selection, or the draft. */
  readonly mode: "write" | "selection" | "draft";
  readonly from: number;
  readonly to: number;
  /** The selected text, for `selection`. */
  readonly selection?: string;
}

/** What the AI field acts on right now. */
export function writeTarget(editor: Editor): WriteTarget {
  const { doc, selection } = editor.state;
  const all = { from: 0, to: doc.content.size };
  if (!selection.empty) {
    const text = doc.textBetween(selection.from, selection.to, "\n", " ");
    if (text.trim())
      return {
        mode: "selection",
        from: selection.from,
        to: selection.to,
        selection: text,
      };
  }
  return { mode: draftText(editor).trim() ? "draft" : "write", ...all };
}

/** The draft as plain text (paragraphs are lines, as in the sent mail). */
export function draftText(editor: Editor): string {
  return editor.getText({ blockSeparator: "\n" });
}

const LIST_ITEM = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/;

/** Plain text as editor nodes: a paragraph per line, `- ` and `1. ` lists. */
export function textNodes(schema: Schema, text: string): ProseMirrorNode[] {
  const { paragraph, bulletList, orderedList, listItem } = schema.nodes;
  // Mail text has no Markdown: **bold** loses its stars.
  const line = (raw: string) => {
    const content = raw.replace(/\*\*(.+?)\*\*/g, "$1");
    return paragraph?.create(null, content ? schema.text(content) : null);
  };
  const nodes: ProseMirrorNode[] = [];
  let items: { ordered: boolean; texts: string[] } | undefined;
  const closeList = () => {
    if (!items) return;
    const list = items.ordered ? orderedList : bulletList;
    const children = items.texts.flatMap((item) => {
      const inner = line(item);
      return inner && listItem ? [listItem.create(null, inner)] : [];
    });
    const node = list?.create(null, children);
    if (node) nodes.push(node);
    items = undefined;
  };
  for (const raw of text
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")) {
    const item = LIST_ITEM.exec(raw);
    if (item && listItem) {
      const ordered = item[2] !== undefined;
      if (items?.ordered !== ordered) closeList();
      items ??= { ordered, texts: [] };
      items.texts.push(item[3] ?? "");
      continue;
    }
    closeList();
    const node = line(raw);
    if (node) nodes.push(node);
  }
  closeList();
  return nodes;
}

/** The text as a slice that fits where `target` is. */
function sliceOf(editor: Editor, target: WriteTarget, text: string): Slice {
  const nodes = textNodes(editor.schema, text);
  if (nodes.length === 0) return Slice.empty;
  // A selection inside a paragraph: the first and last lines join it.
  const open = (node: ProseMirrorNode | undefined) =>
    target.mode === "selection" && node?.type.name === "paragraph" ? 1 : 0;
  return new Slice(
    Fragment.fromArray(nodes),
    open(nodes[0]),
    open(nodes.at(-1)),
  );
}

/** The writing in progress. */
export interface Writing {
  /** Shows the text so far in the target's place. */
  readonly update: (text: string) => void;
  /** Puts the final text in, as one undo step from the original. */
  readonly finish: (text: string) => void;
  /** Puts the original back (nothing came, or it failed). */
  readonly cancel: () => void;
}

/** Starts writing into `target`; the editor is read-only until it ends. */
export function startWriting(editor: Editor, target: WriteTarget): Writing {
  const original = editor.state.doc.slice(target.from, target.to);
  let end = target.to;
  editor.setEditable(false);

  const replace = (slice: Slice, history: boolean) => {
    const { tr } = editor.state;
    tr.replaceRange(target.from, end, slice);
    end = tr.mapping.map(end);
    if (!history) tr.setMeta("addToHistory", false);
    return tr;
  };
  const restore = () => {
    const tr = replace(original, false);
    // Undo comes back to the original selection (so Try again rewrites it).
    if (target.mode === "selection")
      tr.setSelection(
        TextSelection.create(tr.doc, target.from, target.from + original.size),
      );
    editor.view.dispatch(tr);
  };
  const done = () => {
    editor.setEditable(true);
  };

  return {
    update: (text) => {
      editor.view.dispatch(replace(sliceOf(editor, target, text), false));
    },
    finish: (text) => {
      restore();
      editor.setEditable(true);
      const tr = replace(sliceOf(editor, target, text), true);
      editor.view.dispatch(tr.scrollIntoView());
      editor.commands.focus();
    },
    cancel: () => {
      restore();
      done();
    },
  };
}
