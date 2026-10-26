import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AccountHandle } from "../../accounts/types";
import { isValidAddress } from "../../core/addresses";
import type { Sender } from "../../core/model";
import type { SenderSettings } from "../../core/provider";
import {
  useCatchAll,
  useChangeSenders,
  type SenderSetup,
} from "../../data/senders";
import { errorMessage } from "../common/errorMessage";
import { Icon } from "../common/Icon";
import { useT } from "../../i18n/context";
import {
  addressRequested,
  addressSettingsId,
  takeAddressRequest,
} from "./addressSettingsLink";
import { SignatureEditor } from "./SignatureEditor";

const HINT = "text-xs text-zinc-500 dark:text-zinc-400";
const FIELD =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 pointer-coarse:min-h-11";
const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800 pointer-coarse:min-h-11";
const PRIMARY =
  "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 pointer-coarse:min-h-11";
const DANGER =
  "rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 pointer-coarse:min-h-11";
const LINK =
  "rounded px-1.5 py-0.5 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-500/15 pointer-coarse:min-h-11";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const domainOf = (address: string) =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** What the address form edits (the default is chosen in the list). */
type AddressFields = Omit<SenderSettings, "isDefault">;

/**
 * The From addresses of an account whose addresses are managed here (IMAP,
 * Outlook): one card per address with its settings and signature, "Add
 * address", and the catch-all domains. Every change is saved right away.
 */
export function AccountAddresses({
  handle,
  senders,
}: {
  readonly handle: AccountHandle;
  readonly senders: readonly Sender[] | undefined;
}) {
  const accountId = handle.account.id;
  const t = useT();
  const s = t.settings;
  const { mutateAsync, isPending } = useChangeSenders();
  const { data: catchAll = [] } = useCatchAll(accountId);
  // "Add an address…" in the composer's From list leads here.
  const [adding, setAdding] = useState(() => addressRequested(accountId));
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    if (takeAddressRequest(accountId))
      document
        .getElementById(addressSettingsId(accountId))
        ?.scrollIntoView({ block: "start" });
  }, [accountId]);
  // Focus goes back to "Add address" when the form closes or a card goes.
  const addButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (adding || !refocus.current) return;
    refocus.current = false;
    addButton.current?.focus();
  }, [adding]);
  const closeForm = () => {
    refocus.current = true;
    setAdding(false);
  };

  const change = (update: (current: SenderSetup) => SenderSetup) =>
    mutateAsync({ accountId, change: update }).then(
      () => {
        setFailure(undefined);
      },
      (error: unknown) => {
        setFailure(s.notSaved(errorMessage(error, t)));
        throw error;
      },
    );
  const own = handle.account.email;
  const addresses = senders?.map((sender) => sender.address) ?? [];
  // New addresses start with the name of the account's own one.
  const ownName = senders?.find((sender) => same(sender.address, own))?.name;
  const domains = [...new Set(addresses.map(domainOf))];

  return (
    <div className="space-y-3">
      {senders?.map((sender) => (
        <AddressCard
          key={sender.address}
          handle={handle}
          sender={sender}
          own={same(sender.address, own)}
          busy={isPending}
          onDefault={() =>
            change(({ senders: list, catchAll: domains }) => ({
              senders: list.map((other) => ({
                ...other,
                isDefault: same(other.address, sender.address),
              })),
              catchAll: domains,
            }))
          }
          onEdit={(fields) =>
            change(({ senders: list, catchAll: domains }) => ({
              senders: list.map((other) =>
                same(other.address, sender.address)
                  ? { ...fields, isDefault: other.isDefault }
                  : other,
              ),
              catchAll: domains,
            }))
          }
          onRemove={() =>
            change(({ senders: list, catchAll: domains }) => ({
              senders: list.filter(
                (other) => !same(other.address, sender.address),
              ),
              catchAll: domains,
            })).then(() => {
              addButton.current?.focus();
            })
          }
        />
      ))}
      {senders &&
        (adding ? (
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <AddressForm
              title={s.newAddress}
              showTitle
              initial={{ address: "", ...(ownName ? { name: ownName } : {}) }}
              taken={addresses}
              focusFirst
              onSave={(fields) =>
                change(({ senders: list, catchAll: domains }) => ({
                  senders: [...list, { ...fields, isDefault: false }],
                  catchAll: domains,
                })).then(closeForm)
              }
              onCancel={closeForm}
            />
          </div>
        ) : (
          <button
            ref={addButton}
            type="button"
            onClick={() => {
              setAdding(true);
            }}
            className={`flex items-center gap-1.5 ${BUTTON}`}
          >
            <Icon name="plus" className="size-4" />
            {s.addAddress}
          </button>
        ))}
      {failure && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {failure}
        </p>
      )}
      {senders && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{s.catchAll}</legend>
          <p className={HINT}>{s.catchAllHint}</p>
          {domains.map((domain) => (
            <label
              key={domain}
              className="flex cursor-pointer items-start gap-2.5 pointer-coarse:min-h-11"
            >
              <input
                type="checkbox"
                checked={catchAll.includes(domain)}
                disabled={isPending}
                onChange={(event) => {
                  const on = event.target.checked;
                  void change(({ senders: list, catchAll: current }) => ({
                    senders: list,
                    catchAll: on
                      ? [...current, domain]
                      : current.filter((other) => other !== domain),
                  })).catch(() => undefined);
                }}
                className="mt-0.5 size-4 shrink-0 accent-blue-600"
              />
              <span className="text-sm">{s.catchAllFor(domain)}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** One address: default choice, Edit, Remove, its settings and signature. */
function AddressCard({
  handle,
  sender,
  own,
  busy,
  onDefault,
  onEdit,
  onRemove,
}: {
  readonly handle: AccountHandle;
  readonly sender: Sender;
  /** The account's own address: it can't be removed or changed. */
  readonly own: boolean;
  readonly busy: boolean;
  readonly onDefault: () => Promise<void>;
  readonly onEdit: (fields: AddressFields) => Promise<void>;
  readonly onRemove: () => Promise<void>;
}) {
  const t = useT();
  const s = t.settings;
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  // Focus moves into the question, and back to Edit or Remove after.
  const refocus = useRef<"edit" | "remove" | null>(null);
  useEffect(() => {
    if (removing) cancelRef.current?.focus();
    else if (refocus.current === "remove") removeRef.current?.focus();
    if (!editing && refocus.current === "edit") editRef.current?.focus();
    if (!removing && !editing) refocus.current = null;
  }, [removing, editing]);
  const stopEditing = () => {
    refocus.current = "edit";
    setEditing(false);
  };
  const { address } = sender;
  const label = sender.name ? `${sender.name} <${address}>` : address;
  const summary = [
    ...(sender.replyTo ? [s.replyToSummary(sender.replyTo.address)] : []),
    ...(sender.bccSelf ? [s.bccSelf] : []),
  ];

  return (
    <div className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {label}
        </span>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400 pointer-coarse:min-h-11">
          <input
            type="radio"
            name={`default-sender-${handle.account.id}`}
            checked={sender.isDefault}
            disabled={busy}
            aria-label={s.defaultFor(address)}
            onChange={() => {
              void onDefault().catch(() => undefined);
            }}
            className="size-4 accent-blue-600"
          />
          <span aria-hidden="true">{s.makeDefault}</span>
        </label>
        {!editing && (
          <button
            ref={editRef}
            type="button"
            aria-label={s.editAddressOf(address)}
            onClick={() => {
              setEditing(true);
            }}
            className={LINK}
          >
            {t.common.edit}
          </button>
        )}
        {!own && !removing && (
          <button
            ref={removeRef}
            type="button"
            aria-label={s.removeAddressOf(address)}
            onClick={() => {
              setRemoving(true);
            }}
            className={LINK}
          >
            {t.common.remove}
          </button>
        )}
      </div>
      {summary.length > 0 && !editing && (
        <p className={HINT}>{summary.join(" · ")}</p>
      )}
      {removing && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-red-50 p-2 dark:bg-red-500/10">
          <p className="min-w-0 flex-1 text-sm">
            {s.removeAddressQuestion(address)}
          </p>
          <button
            ref={cancelRef}
            type="button"
            onClick={() => {
              refocus.current = "remove";
              setRemoving(false);
            }}
            className={BUTTON}
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void onRemove().catch(() => undefined);
            }}
            className={DANGER}
          >
            {t.common.remove}
          </button>
        </div>
      )}
      {editing && (
        <AddressForm
          title={s.editAddressOf(address)}
          initial={{
            address,
            ...(sender.name ? { name: sender.name } : {}),
            ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
            ...(sender.bccSelf ? { bccSelf: true } : {}),
          }}
          fixedAddress
          focusFirst
          note={own ? s.accountAddress : undefined}
          taken={[]}
          onSave={(fields) => onEdit(fields).then(stopEditing)}
          onCancel={stopEditing}
        />
      )}
      <SignatureEditor handle={handle} sender={sender} compact />
    </div>
  );
}

/**
 * Name, address, Reply-To and Bcc to myself. The address is fixed once it
 * exists (a different one is a new address).
 */
function AddressForm({
  title,
  showTitle = false,
  initial,
  fixedAddress = false,
  note,
  taken,
  focusFirst = false,
  onSave,
  onCancel,
}: {
  readonly title: string;
  /** Shows the title as a heading (a new address has no card to name it). */
  readonly showTitle?: boolean;
  readonly initial: AddressFields;
  readonly fixedAddress?: boolean;
  readonly note?: string | undefined;
  /** Addresses already in the list. */
  readonly taken: readonly string[];
  readonly focusFirst?: boolean;
  /** Rejects if saving failed (the account shows why). */
  readonly onSave: (fields: AddressFields) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const t = useT();
  const s = t.settings;
  const id = useId();
  const [name, setName] = useState(initial.name ?? "");
  const [address, setAddress] = useState(initial.address);
  const [replyTo, setReplyTo] = useState(initial.replyTo?.address ?? "");
  const [bccSelf, setBccSelf] = useState(initial.bccSelf === true);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusFirst) first.current?.focus();
  }, [focusFirst]);

  const submit = () => {
    const trimmed = address.trim();
    const reply = replyTo.trim();
    if (!isValidAddress(trimmed)) {
      setProblem(s.notAnAddress(trimmed));
      return;
    }
    if (taken.some((other) => same(other, trimmed))) {
      setProblem(s.addressExists(trimmed));
      return;
    }
    if (reply && !isValidAddress(reply)) {
      setProblem(s.notAnAddress(reply));
      return;
    }
    setProblem(undefined);
    setSaving(true);
    onSave({
      address: trimmed,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(reply ? { replyTo: { address: reply } } : {}),
      ...(bccSelf ? { bccSelf: true } : {}),
    })
      .catch(() => undefined)
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <form
      aria-label={title}
      noValidate
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {showTitle && <h5 className="text-sm font-medium">{title}</h5>}
      <Field id={`${id}-address`} label={s.address} hint={note}>
        <input
          ref={fixedAddress ? undefined : first}
          // Opened from the composer: Settings starts here.
          data-initial-focus={(focusFirst && !fixedAddress) || undefined}
          id={`${id}-address`}
          type="email"
          autoComplete="off"
          disabled={fixedAddress}
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
          }}
          className={FIELD}
        />
      </Field>
      <Field id={`${id}-name`} label={s.name}>
        <input
          ref={fixedAddress ? first : undefined}
          id={`${id}-name`}
          autoComplete="off"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className={FIELD}
        />
      </Field>
      <Field id={`${id}-reply`} label={s.replyToOptional} hint={s.replyToHint}>
        <input
          id={`${id}-reply`}
          type="email"
          autoComplete="off"
          value={replyTo}
          onChange={(event) => {
            setReplyTo(event.target.value);
          }}
          className={FIELD}
        />
      </Field>
      <label className="flex cursor-pointer items-start gap-2.5 pointer-coarse:min-h-11">
        <input
          type="checkbox"
          checked={bccSelf}
          onChange={(event) => {
            setBccSelf(event.target.checked);
          }}
          className="mt-0.5 size-4 shrink-0 accent-blue-600"
        />
        <span className="text-sm">
          {s.bccSelf}
          <span className={`block ${HINT}`}>{s.bccSelfHint}</span>
        </span>
      </label>
      {problem && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={BUTTON}>
          {t.common.cancel}
        </button>
        <button type="submit" disabled={saving} className={PRIMARY}>
          {t.common.save}
        </button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  );
}
