import type { MessageKey } from "../../core/ids";
import type { MessageSummary } from "../../core/model";
import type { ListRow } from "../../data/listRows";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { useRouter, useUi, useUiStore } from "../../state/context";
import { listRoute } from "../../state/router";
import type { MenuPosition } from "../../state/uiStore";
import { mailActionItems } from "../actions/mailActionItems";
import { useMailActions } from "../actions/useMailActions";
import { copyText } from "../common/clipboard";
import { ContextMenu, type MenuEntry } from "../common/ContextMenu";
import { displayName } from "../common/format";
import { entriesOf, grouped } from "../common/menuEntries";
import { routeUrl } from "../common/routeUrl";
import { useComposeActions } from "../composer/useComposeActions";
import { useBreakpoint, useCoarsePointer } from "../layout/useBreakpoint";
import { answerItems } from "../reader/answerItems";
import { routeOfRow, useCurrentList } from "./useCurrentList";
import { originalItems, useOriginalActions } from "../original/originalActions";
import { aiItems, useAiReaderActions } from "../ai/aiItems";
import { aiTarget } from "../ai/useAi";

/** Props of {@link RowMenu}. */
export interface RowMenuProps {
  readonly keys: readonly MessageKey[];
  readonly at: MenuPosition;
  readonly onClose: () => void;
}

/** A conversation as one message: read if all are, starred if any is. */
function summaryOf(row: ListRow): MessageSummary {
  const { thread, summary } = row;
  if (!thread) return summary;
  return {
    ...summary,
    flags: {
      seen: thread.messages.every((message) => message.flags.seen),
      flagged: thread.messages.some((message) => message.flags.flagged),
    },
  };
}

/**
 * The context menu of message list rows: the selection when the clicked
 * row is part of it, else that row. One row also offers opening, answering
 * and its sender.
 */
export function RowMenu({ keys, at, onClose }: RowMenuProps) {
  const { route, rows, sources } = useCurrentList();
  const actions = useMailActions();
  const compose = useComposeActions();
  const t = useT();
  const m = t.menus;
  const breakpoint = useBreakpoint();
  const coarse = useCoarsePointer();
  const platform = usePlatform();
  const store = useUiStore();
  const router = useRouter();
  const selectedIds = useUi((state) => state.selectedIds);
  const original = useOriginalActions();
  const ai = useAiReaderActions();
  const chosen = (rows ?? []).filter((row) => keys.includes(row.key));
  if (!route || chosen.length === 0) return null;
  const [single] = chosen.length === 1 ? chosen : [];
  const source = single ? sources.get(single.accountId) : undefined;
  const inboxOf = (row: ListRow) =>
    sources.get(row.accountId)?.mailboxes?.find((mb) => mb.role === "inbox")
      ?.id;
  const archivable = chosen.some((row) => {
    const inbox = inboxOf(row);
    const messages = row.thread?.messages ?? [row.summary];
    return (
      inbox !== undefined &&
      messages.some((message) => message.mailboxIds.includes(inbox))
    );
  });

  const opening: MenuEntry[] = [];
  const answering: MenuEntry[] = [];
  const asking: MenuEntry[] = [];
  const sender: MenuEntry[] = [];
  if (single) {
    const ref = { accountId: single.accountId, messageId: single.summary.id };
    const list = listRoute(route);
    const isDraft = source?.scope?.role === "drafts";
    if (coarse && !selectedIds.has(single.key))
      opening.push({
        id: "select",
        label: m.select,
        icon: "list",
        run: () => {
          store.getState().toggle(single.key);
        },
      });
    const openRow = () => {
      store.getState().focusOnly(single.key);
      if (breakpoint === "narrow")
        router.navigate(routeOfRow(list, single.key, sources));
    };
    opening.push({
      id: "open",
      label: m.open,
      icon: isDraft ? "pencil" : "mail-open",
      run: () => {
        if (isDraft) {
          compose.editDraft({
            accountId: single.accountId,
            messageId: single.id,
          });
          return;
        }
        openRow();
      },
    });
    if (!isDraft)
      asking.push(
        ...entriesOf(
          aiItems(
            {
              ...ai,
              // The row opens first, so its panel shows.
              open: (target, start) => {
                openRow();
                ai.open(target, start);
              },
            },
            single.thread
              ? aiTarget.thread(single.accountId, single.thread.id)
              : aiTarget.message(single.accountId, single.summary.id),
            compose.canWriteFrom(single.accountId) ? ref : undefined,
            { phone: false },
            t,
          ),
        ),
      );
    if (platform.kind === "web")
      opening.push({
        id: "open-tab",
        label: m.openInNewTab,
        icon: "external-link",
        run: () => {
          platform.openExternal(
            routeUrl(routeOfRow(list, single.key, sources)),
          );
        },
      });
    if (!isDraft && compose.canWriteFrom(single.accountId))
      answering.push(
        ...entriesOf(
          answerItems(compose, ref, { isDraft: false, phone: false }, t),
        ),
      );
    const from = single.summary.from;
    if (from) {
      const name = displayName(from, t.common.unknownSender);
      sender.push(
        {
          id: "mail-from",
          label: m.mailFrom(name),
          icon: "search",
          run: () => {
            router.navigate({
              ...(route.unified
                ? {
                    accountId: route.accountId,
                    mailboxId: route.mailboxId,
                    unified: true as const,
                  }
                : { accountId: single.accountId, mailboxId: route.mailboxId }),
              search: { text: `from:${from.address}`, everywhere: true },
            });
          },
        },
        {
          id: "copy-sender",
          label: m.copySender,
          icon: "user",
          run: () => {
            copyText(from.address, store, t);
          },
        },
      );
    }
  }

  const acting = entriesOf(
    mailActionItems(
      actions,
      {
        keys,
        archivable,
        ...(single
          ? { message: summaryOf(single), accountId: single.accountId }
          : {}),
      },
      t.actions,
    ),
  );
  // A conversation row stands for its newest message shown here.
  const showing = single
    ? entriesOf(
        originalItems(
          original,
          { accountId: single.accountId, messageId: single.summary.id },
          t,
        ),
      )
    : [];
  const conversations = chosen.some((row) => row.thread !== undefined);
  const title = single
    ? single.summary.subject || t.common.noSubject
    : conversations
      ? t.common.conversations(chosen.length)
      : t.common.messages(chosen.length);
  return (
    <ContextMenu
      label={title}
      title={title}
      at={at}
      entries={grouped(opening, answering, asking, acting, sender, showing)}
      onClose={onClose}
    />
  );
}
