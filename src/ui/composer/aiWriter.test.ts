import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { startWriting, textNodes, writeTarget } from "./aiWriter";

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

function editorWith(html: string): Editor {
  editor = new Editor({ extensions: [StarterKit], content: html });
  return editor;
}

/** Selects the first occurrence of `text`. */
function select(current: Editor, text: string) {
  let from = -1;
  current.state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText) {
      const at = node.text?.indexOf(text) ?? -1;
      if (at >= 0) from = pos + at;
    }
  });
  current.commands.setTextSelection({ from, to: from + text.length });
}

describe("the AI writing into the editor", () => {
  it("knows what to act on: an empty draft, the selection, or the draft", () => {
    const current = editorWith("<p></p>");
    expect(writeTarget(current).mode).toBe("write");
    current.commands.setContent("<p>Hello there. This is long.</p>");
    expect(writeTarget(current)).toMatchObject({ mode: "draft", from: 0 });
    select(current, "This is long.");
    expect(writeTarget(current)).toMatchObject({
      mode: "selection",
      selection: "This is long.",
    });
  });

  it("replaces only the selection as it writes, as one undo step", () => {
    const original = "<p>Hello there. This is long.</p><p>Bye</p>";
    const current = editorWith(original);
    select(current, "This is long.");
    const writing = startWriting(current, writeTarget(current));
    expect(current.isEditable).toBe(false);
    writing.update("Sh");
    expect(current.getHTML()).toBe("<p>Hello there. Sh</p><p>Bye</p>");
    writing.update("Short.");
    writing.finish("Short.");
    expect(current.isEditable).toBe(true);
    expect(current.getHTML()).toBe("<p>Hello there. Short.</p><p>Bye</p>");
    current.commands.undo();
    expect(current.getHTML()).toBe(original);
    // Undo brings the selection back, so it can be rewritten again.
    expect(writeTarget(current).selection).toBe("This is long.");
  });

  it("writes a whole draft with paragraphs and lists, and puts it back when nothing comes", () => {
    const current = editorWith("<p>Old text</p>");
    const writing = startWriting(current, writeTarget(current));
    writing.finish("Hi Anna,\n\n- one\n- **two**\n\nBest regards");
    expect(current.getHTML()).toBe(
      "<p>Hi Anna,</p><p></p><ul><li><p>one</p></li><li><p>two</p></li></ul><p></p><p>Best regards</p>",
    );

    const again = startWriting(current, writeTarget(current));
    again.update("Something");
    again.cancel();
    expect(current.getText()).toContain("Hi Anna,");
    expect(current.isEditable).toBe(true);
  });

  it("builds text as nodes, never as HTML", () => {
    const current = editorWith("<p></p>");
    const nodes = textNodes(current.schema, "<b>not bold</b>\n1. first");
    expect(nodes.map((node) => node.type.name)).toEqual([
      "paragraph",
      "orderedList",
    ]);
    expect(nodes[0]?.textContent).toBe("<b>not bold</b>");
  });
});
