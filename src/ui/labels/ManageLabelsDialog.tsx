import { useId } from "react";
import { useAccountHandle } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import { isOwnMailbox, mailboxPath } from "../../data/mailboxActions";
import { useUi } from "../../state/context";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { useLabelActions } from "./useLabelActions";
import { useMailboxList } from "../common/mailboxNames";
import { useT } from "../../i18n/context";

/** Shows "Manage labels" while it's open. */
export function ManageLabelsHost() {
  const accountId = useUi((state) => state.manageLabels);
  if (!accountId) return null;
  return <ManageLabelsDialog accountId={accountId} />;
}

/**
 * Every label of the account, hidden ones included, with Edit, Show/Hide
 * and Delete, and a button for new ones.
 */
function ManageLabelsDialog({ accountId }: { accountId: AccountId }) {
  const setManageLabels = useUi((state) => state.setManageLabels);
  const setLabelDialog = useUi((state) => state.setLabelDialog);
  const email = useAccountHandle(accountId)?.account.email;
  const { data: mailboxes = [], isPending } = useMailboxList(accountId);
  const labels = useLabelActions();
  const t = useT();
  const l = t.labels;
  const titleId = useId();
  const close = () => {
    setManageLabels(null);
  };
  const rows = mailboxes
    .filter(isOwnMailbox)
    .map((mailbox) => ({ mailbox, path: mailboxPath(mailbox, mailboxes) }))
    .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")));
  const action =
    "rounded-md px-2 py-1 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:min-h-11 pointer-coarse:px-3";

  return (
    <Sheet labelledBy={titleId} onEscape={close} size="lg">
      <div className="flex items-center gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
        <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold">
          {l.manageLabels}{" "}
          {email && (
            <span className="text-sm font-normal text-zinc-500">{email}</span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => {
            setLabelDialog({ mode: "create", accountId });
          }}
          className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 pointer-coarse:min-h-11"
        >
          <Icon name="plus" className="size-4" />
          {l.newLabel}
        </button>
        <IconButton label={t.common.close} icon="x" onClick={close} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {rows.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-zinc-500">
            {isPending ? l.loadingLabels : l.noLabels}
          </p>
        )}
        <ul aria-label={l.allLabels} className="space-y-px">
          {rows.map(({ mailbox, path }) => (
            <li
              key={mailbox.id}
              className="flex items-center gap-2 rounded-md py-1 pr-1 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              style={{ paddingLeft: `${(path.length - 1) * 1.25 + 0.5}rem` }}
            >
              <Icon
                name="tag"
                className="size-4 shrink-0 text-zinc-500"
                style={
                  mailbox.color
                    ? { color: mailbox.color.background }
                    : undefined
                }
              />
              <span className="min-w-0 flex-1 truncate">
                {mailbox.name}
                {mailbox.hidden && (
                  <span className="ml-2 rounded bg-zinc-100 px-1.5 py-px text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    {l.hidden}
                  </span>
                )}
              </span>
              <button
                type="button"
                aria-label={l.editNamed(mailbox.name)}
                onClick={() => {
                  setLabelDialog({
                    mode: "edit",
                    accountId,
                    mailboxId: mailbox.id,
                    focus: "name",
                  });
                }}
                className={action}
              >
                {t.common.edit}
              </button>
              <button
                type="button"
                aria-label={
                  mailbox.hidden
                    ? l.showNamed(mailbox.name)
                    : l.hideNamed(mailbox.name)
                }
                onClick={() => {
                  labels.toggleHidden(accountId, mailbox);
                }}
                className={`${action} min-w-12`}
              >
                {mailbox.hidden ? l.show : l.hide}
              </button>
              <button
                type="button"
                aria-label={l.deleteNamed(mailbox.name)}
                onClick={() => {
                  labels.requestDelete(accountId, mailbox);
                }}
                className={`${action} text-red-700 dark:text-red-400`}
              >
                {t.common.delete}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
