import { useId } from "react";
import { useAccountHandle } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import type { Mailbox, MailboxKind } from "../../core/model";
import { isOwnMailbox, mailboxPath } from "../../data/mailboxActions";
import { useUi } from "../../state/context";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { useLabelActions } from "./useLabelActions";
import { useMailboxList } from "../common/mailboxNames";
import { useT } from "../../i18n/context";
import { mailboxTexts } from "./mailboxTexts";

/** Shows "Manage labels" while it's open. */
export function ManageLabelsHost() {
  const accountId = useUi((state) => state.manageLabels);
  if (!accountId) return null;
  return <ManageLabelsDialog accountId={accountId} />;
}

/**
 * Every label (or folder) of the account, hidden ones included, with Edit,
 * Show/Hide and Delete, and a button for new ones. Outlook accounts get a
 * second section for their categories.
 */
function ManageLabelsDialog({ accountId }: { accountId: AccountId }) {
  const setManageLabels = useUi((state) => state.setManageLabels);
  const setLabelDialog = useUi((state) => state.setLabelDialog);
  const handle = useAccountHandle(accountId);
  const email = handle?.account.email;
  const capabilities = handle?.provider.capabilities;
  const { data: mailboxes = [], isPending } = useMailboxList(accountId);
  const t = useT();
  const l = mailboxTexts(t, capabilities);
  const titleId = useId();
  const close = () => {
    setManageLabels(null);
  };
  // The account's own kind first (Outlook: folders, then categories).
  const kinds = (["folder", "label"] as const).filter(
    (kind) => capabilities?.mailboxEditing[kind] !== undefined,
  );
  const several = kinds.length > 1;
  const create = (kind: MailboxKind) => {
    setLabelDialog({
      mode: "create",
      accountId,
      ...(several && kind === "label" ? { kind } : {}),
    });
  };

  return (
    <Sheet labelledBy={titleId} onEscape={close} size="lg">
      <div className="flex items-center gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
        <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold">
          {l.manageLabels}{" "}
          {email && (
            <span className="text-sm font-normal text-zinc-500">{email}</span>
          )}
        </h2>
        <NewButton
          label={l.newLabel}
          onClick={() => {
            create(kinds[0] ?? "label");
          }}
        />
        <IconButton label={t.common.close} icon="x" onClick={close} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {kinds.map((kind, index) => (
          <Section
            key={kind}
            accountId={accountId}
            kind={kind}
            mailboxes={mailboxes}
            isPending={isPending}
            heading={
              several && index > 0
                ? {
                    onNew: () => {
                      create(kind);
                    },
                  }
                : undefined
            }
          />
        ))}
      </div>
    </Sheet>
  );
}

/** The user's own mailboxes of one kind. */
function Section({
  accountId,
  kind,
  mailboxes,
  isPending,
  heading,
}: {
  readonly accountId: AccountId;
  readonly kind: MailboxKind;
  readonly mailboxes: readonly Mailbox[];
  readonly isPending: boolean;
  /** Shown with a heading and its own "New" button (a second kind). */
  readonly heading: { readonly onNew: () => void } | undefined;
}) {
  const setLabelDialog = useUi((state) => state.setLabelDialog);
  const handle = useAccountHandle(accountId);
  const capabilities = handle?.provider.capabilities;
  const canHide = capabilities?.mailboxEditing[kind]?.hide ?? false;
  const labels = useLabelActions();
  const t = useT();
  const l = mailboxTexts(t, capabilities, kind);
  const headingId = useId();
  const rows = mailboxes
    .filter((mailbox) => mailbox.kind === kind && isOwnMailbox(mailbox))
    .map((mailbox) => ({ mailbox, path: mailboxPath(mailbox, mailboxes) }))
    .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")));
  // Categories sit in a group of their own: indent from there.
  const depth = Math.min(...rows.map(({ path }) => path.length), 1);
  const action =
    "rounded-md px-2 py-1 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:min-h-11 pointer-coarse:px-3";

  return (
    <section
      {...(heading ? { "aria-labelledby": headingId } : {})}
      className={
        heading ? "mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800" : ""
      }
    >
      {heading && (
        <div className="flex items-center gap-2 px-2 pb-2">
          <h3 id={headingId} className="flex-1 text-sm font-semibold">
            {l.allLabels}
          </h3>
          <NewButton label={l.newLabel} onClick={heading.onNew} />
        </div>
      )}
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
            style={{
              paddingLeft: `${(path.length - depth) * 1.25 + 0.5}rem`,
            }}
          >
            <Icon
              name={kind === "folder" ? "folder" : "tag"}
              className="size-4 shrink-0 text-zinc-500"
              style={
                mailbox.color ? { color: mailbox.color.background } : undefined
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
            {canHide && (
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
            )}
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
    </section>
  );
}

function NewButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 pointer-coarse:min-h-11"
    >
      <Icon name="plus" className="size-4" />
      {label}
    </button>
  );
}
