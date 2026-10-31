import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccounts } from "../../accounts/context";
import type { AccountHandle } from "../../accounts/types";
import { isMailError } from "../../core/errors";
import {
  NO_ACTIONS,
  NO_CONDITIONS,
  type AutoReply,
  type FilterServer,
  type FilterServerSettings,
  type FilterSetup,
  type FilterSpec,
} from "../../core/filters";
import type { AccountId } from "../../core/ids";
import { useFilterSetup, type FilterTarget } from "../../data/filters";
import { useT } from "../../i18n/context";
import { useRoute, useRouter, useSettingsEditor } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { useMailboxList } from "../common/mailboxNames";
import { useAsk } from "../common/useAsk";
import { SettingsSection } from "../settings/controls";
import { AutoReplyEditor } from "./AutoReplyEditor";
import { FilterEditor } from "./FilterEditor";
import {
  FILTER_SETTINGS_ID,
  filterRequestFor,
  requestedFilterAccount,
  takeFilterRequest,
} from "./filterLink";
import { autoReplyStatus } from "./describe";
import { FilterList } from "./FilterList";
import { BUTTON, CONTROL, FIELD, HINT, LINK, PRIMARY } from "./styles";
import { useFilterActions } from "./useFilterActions";

/** Settings → Filters: the accounts whose provider has filters. */
export function FilterSettings() {
  const t = useT();
  const f = t.filters;
  const id = useId();
  const accounts = useAccounts().filter((handle) => handle.filters);
  const route = useRoute();
  const [chosen, setChosen] = useState<AccountId | undefined>(
    () => requestedFilterAccount() ?? route?.accountId,
  );
  const handle =
    accounts.find((candidate) => candidate.account.id === chosen) ??
    accounts[0];
  if (!handle) return null;
  return (
    <SettingsSection id={FILTER_SETTINGS_ID} title={f.section}>
      <p className={HINT}>{f.sectionHint}</p>
      {accounts.length > 1 && (
        <div className="space-y-1">
          <label
            htmlFor={`${id}-account`}
            className="block text-sm font-medium"
          >
            {f.account}
          </label>
          <select
            id={`${id}-account`}
            value={handle.account.id}
            onChange={(event) => {
              setChosen(event.target.value as AccountId);
            }}
            className={CONTROL}
          >
            {accounts.map((candidate) => (
              <option key={candidate.account.id} value={candidate.account.id}>
                {candidate.account.email}
              </option>
            ))}
          </select>
        </div>
      )}
      <AccountFilters key={handle.account.id} handle={handle} />
    </SettingsSection>
  );
}

/** What's being edited over Settings. */
type Editing =
  | {
      readonly kind: "filter";
      readonly target: FilterTarget;
      readonly initial: FilterSpec;
    }
  | {
      readonly kind: "auto-reply";
      /** Unset: the account's as loaded. */
      readonly initial?: AutoReply;
    };

/** A new filter's start: mail from `from`, if given. */
function newSpec(from?: string): FilterSpec {
  return {
    enabled: true,
    conditions: { ...NO_CONDITIONS, from: from ? [from] : [] },
    actions: NO_ACTIONS,
  };
}

function AccountFilters({ handle }: { readonly handle: AccountHandle }) {
  const t = useT();
  const f = t.filters;
  const accountId = handle.account.id;
  const setup = useFilterSetup(accountId);
  const mailboxes = useMailboxList(accountId).data ?? [];
  const actions = useFilterActions();
  const router = useRouter();
  const routerEditor = useSettingsEditor();
  const ask = useAsk();
  // "Filter mail like this" and the notice's Edit open an editor here.
  const [editing, setEditing] = useState<Editing | null>(() => {
    const request = filterRequestFor(accountId);
    if (!request) return null;
    return request.kind === "filter"
      ? {
          kind: "filter",
          target: { kind: "new" },
          initial: newSpec(request.from),
        }
      : { kind: "auto-reply" };
  });
  const dirty = useRef(false);
  useEffect(() => {
    if (!takeFilterRequest() || !editing) return;
    document
      .getElementById(FILTER_SETTINGS_ID)
      ?.scrollIntoView({ block: "start" });
    router.openSettingsEditor(editing.kind);
    // Once, for what was asked when Settings opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (next: Editing) => {
    dirty.current = false;
    setEditing(next);
    router.openSettingsEditor(next.kind);
  };
  const close = () => {
    setEditing(null);
    router.closeSettingsEditor();
  };
  const discard = (kind: Editing["kind"]) =>
    ask({
      title: f.discardTitle,
      message: kind === "filter" ? f.discardMessage : f.discardReplyMessage,
      cancelLabel: f.keepEditing,
      options: [{ value: "discard", label: f.discard, tone: "danger" }],
    });
  const cancel = () => {
    if (!editing) return;
    if (!dirty.current) {
      close();
      return;
    }
    void discard(editing.kind).then((answer) => {
      if (answer !== null) close();
    });
  };

  // Back closes the editor in the URL first: with changes, it comes back and asks.
  const shown = useRef(routerEditor);
  useEffect(() => {
    const before = shown.current;
    shown.current = routerEditor;
    if (editing && before !== null && routerEditor === null) {
      if (!dirty.current) {
        setEditing(null);
        return;
      }
      router.openSettingsEditor(editing.kind);
      void discard(editing.kind).then((answer) => {
        if (answer === null) return;
        setEditing(null);
        router.closeSettingsEditor();
      });
    } else if (!editing && routerEditor !== null) {
      // Reloaded or gone forward to an editor whose contents are gone.
      router.closeSettingsEditor();
    }
    // Only when the URL's editor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerEditor]);

  if (setup.isPending)
    return (
      <p className={HINT} role="status">
        {f.loading}
      </p>
    );
  if (setup.isError) {
    const { error } = setup;
    if (
      isMailError(error, "unavailable") &&
      error.reason === "noFilterServer" &&
      handle.filters?.filterServer
    )
      return (
        <ServerChoice
          settings={handle.filters.filterServer}
          host={error.params.service ?? ""}
          onChosen={() => void setup.refetch()}
        />
      );
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {f.couldntLoad(errorMessage(error, t))}
        </p>
        <button
          type="button"
          onClick={() => void setup.refetch()}
          className={BUTTON}
        >
          {t.common.tryAgain}
        </button>
      </div>
    );
  }

  const current: FilterSetup = setup.data;
  const readOnly = current.readOnly !== undefined;
  return (
    <div className="space-y-4">
      {readOnly && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 p-2 text-sm text-amber-950 dark:bg-amber-500/10 dark:text-amber-100">
          <p className="min-w-0 flex-1">{f.readOnly}</p>
          <button
            type="button"
            onClick={() => {
              handle.auth.signIn({ askAgain: true }).then(
                () => void setup.refetch(),
                () => undefined,
              );
            }}
            className={BUTTON}
          >
            {f.allowEditing}
          </button>
        </div>
      )}
      {handle.filters?.filterServer && (
        <ChosenServer
          settings={handle.filters.filterServer}
          onForgotten={() => void setup.refetch()}
        />
      )}
      <AutoReplyRow
        setup={current}
        readOnly={readOnly}
        onEdit={() => {
          open({ kind: "auto-reply", initial: current.autoReply });
        }}
      />
      <FilterList
        accountId={accountId}
        setup={current}
        mailboxes={mailboxes}
        readOnly={readOnly}
        actions={actions}
        onEdit={(filter) => {
          open({
            kind: "filter",
            target: { kind: "edit", filter },
            initial: {
              ...(filter.name === undefined ? {} : { name: filter.name }),
              enabled: filter.enabled,
              conditions: filter.conditions,
              actions: filter.actions,
            },
          });
        }}
      />
      {!readOnly && (
        <button
          type="button"
          onClick={() => {
            open({
              kind: "filter",
              target: { kind: "new" },
              initial: newSpec(),
            });
          }}
          className={BUTTON}
        >
          {f.newFilter}
        </button>
      )}
      {editing?.kind === "filter" &&
        createPortal(
          <FilterEditor
            accountId={accountId}
            setup={current}
            mailboxes={mailboxes}
            target={editing.target}
            initial={editing.initial}
            onDirty={(value) => {
              dirty.current = value;
            }}
            onClose={cancel}
            onSave={async (spec, matches) => {
              await actions.save(accountId, editing.target, spec, matches);
              close();
            }}
          />,
          document.body,
        )}
      {editing?.kind === "auto-reply" &&
        current.capabilities.autoReply &&
        createPortal(
          <AutoReplyEditor
            capabilities={current.capabilities.autoReply}
            initial={editing.initial ?? current.autoReply}
            onDirty={(value) => {
              dirty.current = value;
            }}
            onClose={cancel}
            onSave={async (reply) => {
              await actions.setAutoReply(accountId, reply, current.autoReply);
              close();
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function AutoReplyRow({
  setup,
  readOnly,
  onEdit,
}: {
  readonly setup: FilterSetup;
  readonly readOnly: boolean;
  readonly onEdit: () => void;
}) {
  const t = useT();
  const f = t.filters;
  if (!setup.capabilities.autoReply)
    return <p className={HINT}>{f.sieveNoVacation}</p>;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{f.autoReply}</p>
        <p className={HINT}>{autoReplyStatus(setup.autoReply, t)}</p>
      </div>
      {!readOnly && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`${f.edit}: ${f.autoReply}`}
          className={BUTTON}
        >
          {f.edit}
        </button>
      )}
    </div>
  );
}

/** A mail server without a filter server where action0 looked: enter one. */
function ServerChoice({
  settings,
  host,
  onChosen,
}: {
  readonly settings: FilterServerSettings;
  readonly host: string;
  readonly onChosen: () => void;
}) {
  const t = useT();
  const f = t.filters;
  const id = useId();
  const [server, setServer] = useState({ host, port: "4190" });
  const [state, setState] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "connecting" }
    | { readonly kind: "failed"; readonly message: string }
  >({ kind: "idle" });
  const port = Number(server.port);
  const valid =
    server.host.trim() !== "" &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || state.kind === "connecting") return;
        setState({ kind: "connecting" });
        settings.choose({ host: server.host.trim(), port }).then(
          () => {
            setState({ kind: "idle" });
            onChosen();
          },
          (error: unknown) => {
            setState({ kind: "failed", message: errorMessage(error, t) });
          },
        );
      }}
    >
      <p className="text-sm">{f.noServer(host)}</p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{f.useAnotherServer}</legend>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor={`${id}-host`} className="block text-xs">
              {f.serverHost}
            </label>
            <input
              id={`${id}-host`}
              value={server.host}
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => {
                setServer({ ...server, host: event.target.value });
              }}
              className={FIELD}
            />
          </div>
          <div className="w-24 space-y-1">
            <label htmlFor={`${id}-port`} className="block text-xs">
              {f.serverPort}
            </label>
            <input
              id={`${id}-port`}
              inputMode="numeric"
              value={server.port}
              onChange={(event) => {
                setServer({ ...server, port: event.target.value });
              }}
              className={FIELD}
            />
          </div>
        </div>
      </fieldset>
      {state.kind === "failed" && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {state.message}
        </p>
      )}
      <button
        type="submit"
        disabled={!valid || state.kind === "connecting"}
        className={PRIMARY}
      >
        {state.kind === "connecting" ? f.connecting : f.connect}
      </button>
    </form>
  );
}

/** The filter server the user entered, with a way back to looking for it. */
function ChosenServer({
  settings,
  onForgotten,
}: {
  readonly settings: FilterServerSettings;
  readonly onForgotten: () => void;
}) {
  const t = useT();
  const f = t.filters;
  const [server, setServer] = useState<FilterServer | undefined>();
  useEffect(() => {
    let live = true;
    settings.current().then(
      (current) => {
        if (live) setServer(current);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [settings]);
  if (!server?.chosen) return null;
  return (
    <p className={`flex flex-wrap items-center gap-x-2 ${HINT}`}>
      <span>
        {f.chosenServer(
          server.port === 4190
            ? server.host
            : `${server.host}:${String(server.port)}`,
        )}
      </span>
      <button
        type="button"
        onClick={() => {
          settings.choose(null).then(onForgotten, () => undefined);
        }}
        className={LINK}
      >
        {f.forgetServer}
      </button>
    </p>
  );
}
