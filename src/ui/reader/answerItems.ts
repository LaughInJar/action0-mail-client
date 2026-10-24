import type { MessageRef } from "../../core/ids";
import type { I18n } from "../../i18n/context";
import type { ToolbarItem } from "../actions/mailActionItems";
import type { ComposeActions } from "../composer/useComposeActions";

/**
 * Reply, Reply all and Forward (or Edit for a draft) as toolbar items. On
 * phones they're the first to move into ⋯: the big buttons below the
 * mail do the same.
 */
export function answerItems(
  compose: ComposeActions,
  message: MessageRef | (() => MessageRef),
  { isDraft, phone }: { readonly isDraft: boolean; readonly phone: boolean },
  t: I18n,
): ToolbarItem[] {
  const target = () => (typeof message === "function" ? message() : message);
  const keep = (wide: number) => (phone ? wide - 10 : wide);
  if (isDraft)
    return [
      {
        id: "edit-draft",
        label: t.reader.editDraft,
        icon: "pencil",
        group: "answer",
        keep: keep(6),
        run: () => {
          compose.editDraft(target());
        },
      },
    ];
  return [
    {
      id: "reply",
      label: t.actions.replyButton,
      icon: "reply",
      group: "answer",
      keep: keep(6),
      run: () => {
        compose.reply(target(), "reply");
      },
    },
    {
      id: "reply-all",
      label: t.actions.replyAllButton,
      icon: "reply-all",
      group: "answer",
      keep: keep(2),
      run: () => {
        compose.reply(target(), "reply-all");
      },
    },
    {
      id: "forward",
      label: t.actions.forwardButton,
      icon: "forward",
      group: "answer",
      keep: keep(1),
      run: () => {
        compose.forward(target());
      },
    },
  ];
}
