import type { Rsvp } from "../../core/calendar";
import type { PlacedEvent } from "../../data/calendar";
import { canChange } from "../../data/eventEdits";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { copyText } from "../common/clipboard";
import { ContextMenu, type MenuEntry } from "../common/ContextMenu";
import { grouped } from "../common/menuEntries";
import { titleOf } from "./format";
import { useAnswer } from "./useAnswer";

const ANSWERS: readonly Rsvp[] = ["accepted", "tentative", "declined"];

/** Props of {@link EventMenu}. */
export interface EventMenuProps {
  readonly placed: PlacedEvent;
  readonly at: MenuPosition;
  readonly onOpen: (placed: PlacedEvent) => void;
  readonly onEdit: (placed: PlacedEvent) => void;
  readonly onDelete: (placed: PlacedEvent) => void;
  readonly onClose: () => void;
}

/**
 * The context menu of a calendar event: open it, edit or delete it (your
 * own events in writable calendars), join its meeting, and answer
 * invitations.
 */
export function EventMenu({
  placed,
  at,
  onOpen,
  onEdit,
  onDelete,
  onClose,
}: EventMenuProps) {
  const t = useT();
  const m = t.menus;
  const store = useUiStore();
  const { openExternal } = usePlatform();
  const answer = useAnswer();
  const { event, source } = placed;
  const title = titleOf(event, t);
  const meeting =
    event.meetingUrl && /^https:\/\//i.test(event.meetingUrl)
      ? event.meetingUrl
      : undefined;

  const opening: MenuEntry[] = [
    {
      id: "open",
      label: m.open,
      icon: "calendar",
      run: () => {
        onOpen(placed);
      },
    },
    ...(canChange(placed)
      ? [
          {
            id: "edit",
            label: m.edit,
            icon: "pencil" as const,
            run: () => {
              onEdit(placed);
            },
          },
        ]
      : []),
  ];
  const joining: MenuEntry[] = meeting
    ? [
        {
          id: "join",
          label: m.joinMeeting,
          icon: "video",
          run: () => {
            openExternal(meeting);
          },
        },
        {
          id: "copy-link",
          label: m.copyMeetingLink,
          icon: "link",
          run: () => {
            copyText(meeting, store, t);
          },
        },
      ]
    : [];
  const answering: MenuEntry[] =
    event.myResponse !== undefined && source.provider.canRespond
      ? ANSWERS.map((value) => ({
          id: `answer-${value}`,
          label: m.answers[value],
          checked: event.myResponse === value,
          run: () => {
            answer(source, event, value);
          },
        }))
      : [];
  const deleting: MenuEntry[] = canChange(placed)
    ? [
        {
          id: "delete",
          label: m.delete,
          icon: "trash",
          danger: true,
          run: () => {
            onDelete(placed);
          },
        },
      ]
    : [];
  return (
    <ContextMenu
      label={title}
      title={title}
      at={at}
      entries={grouped(opening, joining, answering, deleting)}
      onClose={onClose}
    />
  );
}
