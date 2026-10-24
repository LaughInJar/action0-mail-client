import {
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { AccountId, MessageId } from "../../core/ids";
import { useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import {
  atPointer,
  belowElement,
  isMenuKey,
  wantsAppMenu,
} from "../common/menuPosition";
import { useLongPress } from "../messages/useLongPress";

/**
 * Handlers that open the context menu of a message in the reader:
 * right-click (Shift keeps the browser's menu), a long press on touch, and
 * the Menu key or Shift+F10 on a focusable element. One hook serves every
 * message of a conversation: call the result with the message's id.
 */
export function useMessageMenu(accountId: AccountId) {
  const store = useUiStore();
  const pointerType = useRef("mouse");
  const pressed = useRef<MessageId | null>(null);
  const open = (messageId: MessageId, at: MenuPosition) => {
    store
      .getState()
      .setContextMenu({ kind: "message", accountId, messageId, at });
  };
  const longPress = useLongPress((_target, at) => {
    if (pressed.current !== null) open(pressed.current, atPointer(at));
  });

  return (messageId: MessageId) => ({
    onPointerDown: (event: PointerEvent) => {
      pointerType.current = event.pointerType;
      pressed.current = messageId;
      longPress.onPointerDown(event);
    },
    onPointerMove: longPress.onPointerMove,
    onPointerUp: longPress.onPointerUp,
    onPointerCancel: longPress.onPointerCancel,
    onContextMenu: (event: MouseEvent) => {
      if (pointerType.current !== "mouse" || !wantsAppMenu(event)) {
        longPress.onContextMenu(event);
        return;
      }
      event.preventDefault();
      open(messageId, atPointer(event));
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (!isMenuKey(event)) return;
      event.preventDefault();
      open(messageId, belowElement(event.currentTarget));
    },
    /** True (once) if the current click ends a long press. */
    consumeClick: longPress.consumeClick,
  });
}
