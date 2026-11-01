import { useId } from "react";
import { useAccounts } from "../../accounts/context";
import type { AccountHandle } from "../../accounts/types";
import { focusViews, isSplit, type FocusRuleChange } from "../../core/focus";
import type { Focus } from "../../core/model";
import { useFocusRules, useSetFocusRules } from "../../data/focusRules";
import { useMailboxes } from "../../data/hooks";
import { useT } from "../../i18n/context";
import { useUi, useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { CONTROL } from "../common/formStyles";

/**
 * Settings → Reading → Focused Inbox (accounts with Outlook's Focused
 * Inbox): a switch per account and its senders that always go to one side.
 */
export function FocusedInboxSettings() {
  const accounts = useAccounts().filter(
    (handle) => handle.provider.capabilities.focusedInbox === true,
  );
  const t = useT();
  const f = t.focus;
  const id = useId();
  if (accounts.length === 0) return null;
  return (
    <fieldset className="space-y-2" aria-describedby={`${id}-description`}>
      <legend className="px-2 text-sm font-medium">{f.title}</legend>
      <p id={`${id}-description`} className="px-2 text-xs text-zinc-500">
        {f.description}
      </p>
      {accounts.map((handle) => (
        <AccountFocus
          key={handle.account.id}
          handle={handle}
          several={accounts.length > 1}
        />
      ))}
    </fieldset>
  );
}

function AccountFocus({
  handle,
  several,
}: {
  readonly handle: AccountHandle;
  readonly several: boolean;
}) {
  const { account } = handle;
  const t = useT();
  const f = t.focus;
  const store = useUiStore();
  const setting = useUi((state) => state.settings.focusedInbox[account.id]);
  const { data: mailboxes } = useMailboxes(account.id);
  const split = mailboxes ? isSplit(mailboxes, setting) : setting === true;
  const offered = !mailboxes || focusViews(mailboxes) !== undefined;
  if (!offered) return null;
  return (
    <div className="space-y-1">
      <label className="flex cursor-pointer items-start gap-2.5 px-2 pointer-coarse:min-h-11">
        <input
          type="checkbox"
          checked={split}
          onChange={(event) => {
            const { settings, updateSettings } = store.getState();
            updateSettings({
              focusedInbox: {
                ...settings.focusedInbox,
                [account.id]: event.target.checked,
              },
            });
          }}
          className="mt-0.5 size-4 shrink-0 accent-blue-600"
        />
        <span className="text-sm">
          {account.email}
          {setting === undefined && !split && (
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
              {f.automatic}
            </span>
          )}
        </span>
      </label>
      <SenderRules handle={handle} several={several} />
    </div>
  );
}

/** The account's senders that always go to Focused or Other: change the side, remove (undoable). */
function SenderRules({
  handle,
  several,
}: {
  readonly handle: AccountHandle;
  readonly several: boolean;
}) {
  const { account } = handle;
  const t = useT();
  const f = t.focus;
  const store = useUiStore();
  const { data: rules, isPending, error } = useFocusRules(account.id);
  const setRules = useSetFocusRules();
  const title = several ? f.rulesFor(account.email) : f.rules;

  const change = (changes: readonly FocusRuleChange[], done: string) => {
    void setRules(account.id, changes).then(
      (back) => {
        store.getState().showToast({
          message: done,
          tone: "info",
          revert: () => {
            setRules(account.id, back).catch((failure: unknown) => {
              store.getState().showToast({
                message: `${t.actions.couldntUndo}: ${errorMessage(failure, t)}`,
                tone: "error",
              });
            });
          },
        });
      },
      (failure: unknown) => {
        store.getState().showToast({
          message: `${f.couldntRule}: ${errorMessage(failure, t)}`,
          tone: "error",
        });
      },
    );
  };

  let body;
  if (error && !rules)
    body = <p className="text-xs text-zinc-500">{errorMessage(error, t)}</p>;
  else if (isPending)
    body = <p className="text-xs text-zinc-500">{f.loadingRules}</p>;
  else if (rules.length === 0)
    body = <p className="text-xs text-zinc-500">{f.noRules}</p>;
  else
    body = (
      <ul aria-label={title} className="space-y-0.5">
        {rules.map((rule) => (
          <li
            key={rule.address}
            className="flex items-center gap-2 rounded-md text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
          >
            <span className="min-w-0 flex-1 truncate">
              {rule.name ? `${rule.name} <${rule.address}>` : rule.address}
            </span>
            <select
              aria-label={f.sideFor(rule.address)}
              value={rule.focus}
              onChange={(event) => {
                const focus = event.target.value as Focus;
                change(
                  [{ address: rule.address, focus }],
                  f.ruleChanged(rule.address, t.mailboxes.standard[focus]),
                );
              }}
              className={`shrink-0 py-1 text-xs ${CONTROL}`}
            >
              <option value="focused">{t.mailboxes.standard.focused}</option>
              <option value="other">{t.mailboxes.standard.other}</option>
            </select>
            <button
              type="button"
              aria-label={f.removeRule(rule.address)}
              onClick={() => {
                change(
                  [{ address: rule.address, focus: null }],
                  f.ruleRemoved(rule.address),
                );
              }}
              className="rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
            >
              {t.common.remove}
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-1 pl-8">
      <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
        {title}
      </p>
      {body}
    </div>
  );
}
