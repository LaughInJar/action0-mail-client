import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  displayNameOf,
  EMPTY_FIELDS,
  fieldsOf,
  nameOf,
  normalized,
  sameFields,
  type Contact,
  type ContactCapabilities,
  type ContactFields,
  type ContactSnapshot,
  type PostalAddress,
  type Typed,
  type ValueKind,
} from "../../core/contacts";
import type { ContactSource, WritableBook } from "../../data/contacts";
import { useT } from "../../i18n/context";
import { errorMessage } from "../common/errorMessage";
import {
  BUTTON,
  CHECK,
  CHECK_ROW,
  CONTROL,
  FIELD,
  HINT,
  LINK,
  PRIMARY,
} from "../common/formStyles";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { useSaveShortcut } from "../common/useSaveShortcut";
import { Icon } from "../common/Icon";
import { ContactAvatar } from "./ContactAvatar";
import { bookLabel } from "./format";
import { PhotoCropper } from "./PhotoCropper";
import { useContactActions } from "./useContactActions";

/** What the editor edits: a contact, or a new one (maybe started from mail). */
export type EditorTarget =
  | {
      readonly kind: "edit";
      readonly source: ContactSource;
      readonly contact: Contact;
      readonly snapshot: ContactSnapshot | undefined;
    }
  | {
      readonly kind: "new";
      /** Where it can go; the first choice is `initial`. */
      readonly books: readonly WritableBook[];
      readonly initial: WritableBook;
      readonly snapshotOf: (source: string) => ContactSnapshot | undefined;
      readonly prefill?: { readonly name?: string; readonly address?: string };
    };

/** The form: the fields, plus groups still to create. */
interface Form {
  readonly fields: ContactFields;
  readonly newGroups: readonly string[];
  /** New contacts: the chosen book's token. */
  readonly book: string;
}

/** "Anna Maria Berger" → first "Anna Maria", last "Berger". */
function splitName(name: string): ContactFields["name"] {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2)
    return { given: parts[0] ?? "", middle: "", family: "" };
  return {
    given: parts.slice(0, -1).join(" "),
    middle: "",
    family: parts.at(-1) ?? "",
  };
}

function initialForm(target: EditorTarget): Form {
  if (target.kind === "edit")
    return { fields: fieldsOf(target.contact), newGroups: [], book: "" };
  const { name, address } = target.prefill ?? {};
  const emailKind: ValueKind = target.initial.source.provider.capabilities
    .emailKinds
    ? "home"
    : "other";
  return {
    fields: {
      ...EMPTY_FIELDS,
      ...(name ? { name: splitName(name) } : {}),
      ...(address ? { emails: [{ value: address, kind: emailKind }] } : {}),
    },
    newGroups: [],
    book: target.initial.token,
  };
}

const EMPTY_ADDRESS = {
  street: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
};

/**
 * The contact editor: a dialog (full screen on phones) with the fields
 * the source can hold. Ctrl/⌘+Enter saves; Esc and Cancel go through
 * `onCancel` (which asks when there are changes, see `onDirty`).
 */
export function ContactEditor({
  target,
  onDirty,
  onCancel,
  onSaved,
}: {
  target: EditorTarget;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
  onSaved: (source: ContactSource, contact: Contact) => void;
}) {
  const t = useT();
  const c = t.contacts;
  const id = useId();
  const actions = useContactActions();
  const formRef = useRef<HTMLFormElement>(null);
  const [initial] = useState(() => initialForm(target));
  const [form, setForm] = useState(initial);
  const [groupName, setGroupName] = useState("");
  /** The picture: as it is, a new one (cropped), or none any more. */
  const [photo, setPhoto] = useState<
    { readonly blob: Blob; readonly url: string } | "keep" | "remove"
  >("keep");
  /** A picked file being cropped. */
  const [cropping, setCropping] = useState<Blob | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      if (typeof photo === "object") URL.revokeObjectURL(photo.url);
    },
    [photo],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen =
    target.kind === "new"
      ? (target.books.find((entry) => entry.token === form.book) ??
        target.initial)
      : undefined;
  const source =
    target.kind === "edit" ? target.source : (chosen ?? target.initial).source;
  const snapshot =
    target.kind === "edit" ? target.snapshot : target.snapshotOf(source.key);
  const capabilities = source.provider.capabilities;
  const fields = form.fields;

  const dirty =
    !sameFields(form.fields, initial.fields) ||
    form.newGroups.length > 0 ||
    form.book !== initial.book ||
    photo !== "keep";
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const setFields = (patch: Partial<ContactFields>) => {
    setForm((current) => ({
      ...current,
      fields: { ...current.fields, ...patch },
    }));
    setError(null);
  };

  const empty = () => {
    const clean = normalized(fields);
    return (
      !clean.name.given &&
      !clean.name.middle &&
      !clean.name.family &&
      !clean.nickname &&
      !clean.organization.company &&
      clean.emails.length === 0 &&
      clean.phones.length === 0
    );
  };

  const save = async () => {
    if (saving) return;
    if (empty()) {
      setError(c.empty);
      return;
    }
    if (
      capabilities.birthdayYear &&
      fields.birthday &&
      fields.birthday.year === undefined
    ) {
      setError(c.yearRequired);
      return;
    }
    // The permission popup (Google) has to open within the click.
    if (!(await actions.ensureWritable(source))) return;
    setSaving(true);
    try {
      const book =
        target.kind === "edit" ? target.contact.addressBookId : chosen?.book.id;
      if (book === undefined) return;
      const saved = await actions.save({
        source,
        ...(target.kind === "edit" ? { contact: target.contact } : {}),
        book,
        fields: normalized(fields),
        newGroups: form.newGroups,
        ...(photo === "keep"
          ? {}
          : { photo: photo === "remove" ? null : photo.blob }),
      });
      onDirty(false);
      onSaved(source, saved);
    } catch (cause) {
      setError(c.couldntSave(errorMessage(cause, t)));
    } finally {
      setSaving(false);
    }
  };
  useSaveShortcut(formRef, () => {
    void save();
  });

  const kindName = (kind: string) =>
    kind in c.kinds ? c.kinds[kind as keyof typeof c.kinds] : kind;

  return (
    <Sheet labelledBy={`${id}-title`} onEscape={onCancel} size="page">
      <form
        ref={formRef}
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-2 pr-2 pl-4 dark:border-zinc-800">
          <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">
            {target.kind === "edit" ? c.editTitle : c.newTitle}
          </h2>
          <IconButton label={c.cancel} icon="x" onClick={onCancel} />
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          {capabilities.photos.change && (
            <PhotoRow
              current={
                typeof photo === "object" ? (
                  <img
                    src={photo.url}
                    alt=""
                    className="size-16 shrink-0 rounded-full object-cover"
                  />
                ) : target.kind === "edit" && photo === "keep" ? (
                  <ContactAvatar
                    source={target.source}
                    contact={target.contact}
                    name={nameOf(target.contact) || displayNameOf(fields)}
                    large
                    fetch
                  />
                ) : (
                  <span className="grid size-16 shrink-0 place-items-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800">
                    <Icon name="user" className="size-7" />
                  </span>
                )
              }
              canRemove={
                capabilities.photos.remove &&
                (typeof photo === "object" ||
                  (photo === "keep" &&
                    target.kind === "edit" &&
                    target.contact.photo !== undefined))
              }
              onPick={() => photoInput.current?.click()}
              onFile={(file) => {
                if (file.type.startsWith("image/")) setCropping(file);
                else setError(c.notAPicture);
              }}
              onRemove={() => {
                setPhoto("remove");
              }}
            />
          )}
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) setCropping(file);
            }}
          />
          {target.kind === "new" && target.books.length > 1 && (
            <div className="space-y-1">
              <label
                htmlFor={`${id}-book`}
                className="block text-sm font-medium"
              >
                {c.saveTo}
              </label>
              <select
                id={`${id}-book`}
                value={form.book}
                onChange={(event) => {
                  const book = event.target.value;
                  setForm((current) => ({
                    ...current,
                    book,
                    // Groups belong to a source.
                    fields: { ...current.fields, groupIds: [] },
                  }));
                }}
                className={FIELD}
              >
                {target.books.map((entry) => (
                  <option key={entry.token} value={entry.token}>
                    {bookLabel(entry, target.books)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-semibold">{c.name}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField
                id={`${id}-given`}
                label={c.firstName}
                value={fields.name.given}
                autoComplete="off"
                initialFocus
                onChange={(given) => {
                  setFields({ name: { ...fields.name, given } });
                }}
              />
              <TextField
                id={`${id}-middle`}
                label={c.middleName}
                value={fields.name.middle}
                onChange={(middle) => {
                  setFields({ name: { ...fields.name, middle } });
                }}
              />
              <TextField
                id={`${id}-family`}
                label={c.lastName}
                value={fields.name.family}
                onChange={(family) => {
                  setFields({ name: { ...fields.name, family } });
                }}
              />
            </div>
            <TextField
              id={`${id}-nickname`}
              label={c.nickname}
              value={fields.nickname}
              onChange={(nickname) => {
                setFields({ nickname });
              }}
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-semibold">{c.work}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField
                id={`${id}-company`}
                label={c.company}
                value={fields.organization.company}
                onChange={(company) => {
                  setFields({
                    organization: { ...fields.organization, company },
                  });
                }}
              />
              <TextField
                id={`${id}-title`}
                label={c.jobTitle}
                value={fields.organization.title}
                onChange={(title) => {
                  setFields({
                    organization: { ...fields.organization, title },
                  });
                }}
              />
              <TextField
                id={`${id}-department`}
                label={c.department}
                value={fields.organization.department}
                onChange={(department) => {
                  setFields({
                    organization: { ...fields.organization, department },
                  });
                }}
              />
            </div>
          </fieldset>

          <TypedList
            legend={c.email}
            addLabel={c.addEmail}
            type="email"
            values={fields.emails}
            kinds={
              capabilities.emailKinds
                ? (["home", "work", "other"] as const)
                : []
            }
            max={capabilities.maxEmails}
            kindName={kindName}
            onChange={(emails) => {
              setFields({ emails });
            }}
          />
          <TypedList
            legend={c.phone}
            addLabel={c.addPhone}
            type="tel"
            values={fields.phones}
            kinds={capabilities.phoneKinds}
            maxPerKind={capabilities.maxPhones}
            kindName={kindName}
            onChange={(phones) => {
              setFields({ phones });
            }}
          />
          <AddressList
            addresses={fields.addresses}
            capabilities={capabilities}
            kindName={kindName}
            onChange={(addresses) => {
              setFields({ addresses });
            }}
          />
          <BirthdayField
            value={fields.birthday}
            yearRequired={capabilities.birthdayYear}
            onChange={(birthday) => {
              setForm((current) => {
                const { birthday: _old, ...rest } = current.fields;
                return {
                  ...current,
                  fields: birthday ? { ...rest, birthday } : rest,
                };
              });
              setError(null);
            }}
          />
          <TypedList
            legend={c.website}
            addLabel={c.addWebsite}
            type="url"
            values={fields.websites}
            kinds={
              capabilities.websiteKinds
                ? (["home", "work", "other"] as const)
                : []
            }
            max={capabilities.maxWebsites}
            kindName={kindName}
            onChange={(websites) => {
              setFields({ websites });
            }}
          />

          {capabilities.groups && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-semibold">{c.groups}</legend>
              {(snapshot?.groups ?? []).map((group) => (
                <label key={group.id} className={CHECK_ROW}>
                  <input
                    type="checkbox"
                    checked={fields.groupIds.includes(group.id)}
                    onChange={(event) => {
                      setFields({
                        groupIds: event.target.checked
                          ? [...fields.groupIds, group.id]
                          : fields.groupIds.filter((at) => at !== group.id),
                      });
                    }}
                    className={CHECK}
                  />
                  <span>{group.name}</span>
                </label>
              ))}
              {form.newGroups.map((name) => (
                <label key={`new-${name}`} className={CHECK_ROW}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => {
                      setForm((current) => ({
                        ...current,
                        newGroups: current.newGroups.filter(
                          (other) => other !== name,
                        ),
                      }));
                    }}
                    className={CHECK}
                  />
                  <span>{name}</span>
                </label>
              ))}
              <div className="flex gap-2">
                <input
                  aria-label={c.newGroup}
                  placeholder={c.newGroupPlaceholder}
                  value={groupName}
                  onChange={(event) => {
                    setGroupName(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.ctrlKey || event.metaKey)
                      return;
                    event.preventDefault();
                    addGroup();
                  }}
                  className={`min-w-0 flex-1 ${CONTROL}`}
                />
                <button
                  type="button"
                  disabled={!groupName.trim()}
                  onClick={addGroup}
                  className={BUTTON}
                >
                  {c.addGroup}
                </button>
              </div>
            </fieldset>
          )}

          <div className="space-y-1">
            <label
              htmlFor={`${id}-notes`}
              className="block text-sm font-semibold"
            >
              {c.notes}
            </label>
            <textarea
              id={`${id}-notes`}
              value={fields.notes}
              rows={4}
              onChange={(event) => {
                setFields({ notes: event.target.value });
              }}
              className={FIELD}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
          {error && (
            <p
              role="alert"
              className="mr-auto min-w-0 text-sm text-red-700 dark:text-red-400"
            >
              {error}
            </p>
          )}
          <button type="button" onClick={onCancel} className={BUTTON}>
            {c.cancel}
          </button>
          <button type="submit" disabled={saving} className={PRIMARY}>
            {saving ? c.saving : c.save}
          </button>
        </div>
      </form>
      {cropping && (
        <PhotoCropper
          file={cropping}
          onCancel={() => {
            setCropping(null);
          }}
          onUse={(blob) => {
            setCropping(null);
            setPhoto({ blob, url: URL.createObjectURL(blob) });
          }}
        />
      )}
    </Sheet>
  );

  function addGroup() {
    const name = groupName.trim();
    if (!name) return;
    const existing = (snapshot?.groups ?? []).find(
      (group) => group.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      if (!fields.groupIds.includes(existing.id))
        setFields({ groupIds: [...fields.groupIds, existing.id] });
    } else if (
      !form.newGroups.some(
        (other) => other.toLowerCase() === name.toLowerCase(),
      )
    )
      setForm((current) => ({
        ...current,
        newGroups: [...current.newGroups, name],
      }));
    setGroupName("");
  }
}

/** The picture at the top of the editor: Change (or drop one on it) and Remove. */
function PhotoRow({
  current,
  canRemove,
  onPick,
  onFile,
  onRemove,
}: {
  current: ReactNode;
  canRemove: boolean;
  onPick: () => void;
  onFile: (file: File) => void;
  onRemove: () => void;
}) {
  const c = useT().contacts;
  const [over, setOver] = useState(false);
  return (
    <div className="flex items-center gap-4">
      {/* The button below does the same for the keyboard. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label={c.changePhoto}
        onClick={onPick}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => {
          setOver(false);
        }}
        onDrop={(event) => {
          const file = event.dataTransfer.files[0];
          if (!file) return;
          // Not an import of contacts, nor a new mail: the picture.
          event.preventDefault();
          event.stopPropagation();
          setOver(false);
          onFile(file);
        }}
        className={`rounded-full ${over ? "ring-4 ring-blue-500" : ""}`}
      >
        {current}
      </button>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onPick} className={BUTTON}>
          {c.changePhoto}
        </button>
        {canRemove && (
          <button type="button" onClick={onRemove} className={LINK}>
            {c.removePhoto}
          </button>
        )}
      </div>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  initialFocus = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  initialFocus?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
      >
        {label}
      </label>
      <input
        id={id}
        value={value}
        autoComplete={autoComplete}
        {...(initialFocus ? { "data-initial-focus": true } : {})}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={FIELD}
      />
    </div>
  );
}

/** Rows of values with their kinds (emails, phones, websites). */
function TypedList<K extends string>({
  legend,
  addLabel,
  type,
  values,
  kinds,
  max,
  maxPerKind,
  kindName,
  onChange,
}: {
  legend: string;
  addLabel: string;
  type: "email" | "tel" | "url";
  values: readonly Typed<K>[];
  /** The kinds there are; none: values have no kind (Outlook's emails). */
  kinds: readonly K[];
  max?: number | undefined;
  maxPerKind?: Partial<Readonly<Record<K, number>>> | undefined;
  kindName: (kind: string) => string;
  onChange: (values: Typed<K>[]) => void;
}) {
  const t = useT();
  const c = t.contacts;
  const id = useId();
  const count = (kind: K) =>
    values.filter((value) => value.kind === kind).length;
  const room = (kind: K) => count(kind) < (maxPerKind?.[kind] ?? Infinity);
  const nextKind = kinds.find(room) ?? kinds[0];
  const full =
    (max !== undefined && values.length >= max) ||
    (maxPerKind !== undefined && kinds.every((kind) => !room(kind)));
  const limit =
    max ??
    (maxPerKind
      ? kinds.reduce((sum, kind) => sum + (maxPerKind[kind] ?? 0), 0)
      : undefined);
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-semibold">{legend}</legend>
      {values.map((value, index) => (
        <div key={index} className="flex items-center gap-2">
          {kinds.length > 0 && (
            <select
              aria-label={c.kind(legend)}
              value={
                value.label === undefined ? value.kind : `label:${value.label}`
              }
              onChange={(event) => {
                const kind = event.target.value as K;
                onChange(
                  values.map((other, at) =>
                    at === index ? { value: other.value, kind } : other,
                  ),
                );
              }}
              className={CONTROL}
            >
              {value.label !== undefined && (
                <option value={`label:${value.label}`}>{value.label}</option>
              )}
              {kinds.map((kind) => (
                <option
                  key={kind}
                  value={kind}
                  disabled={kind !== value.kind && !room(kind)}
                >
                  {kindName(kind)}
                </option>
              ))}
            </select>
          )}
          <input
            type={type}
            aria-label={legend}
            value={value.value}
            onChange={(event) => {
              onChange(
                values.map((other, at) =>
                  at === index
                    ? { ...other, value: event.target.value }
                    : other,
                ),
              );
            }}
            className={`min-w-0 flex-1 ${CONTROL}`}
          />
          <IconButton
            label={c.remove(value.value || legend)}
            icon="x"
            onClick={() => {
              onChange(values.filter((_, at) => at !== index));
            }}
          />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          id={`${id}-add`}
          disabled={full}
          onClick={() => {
            onChange([
              ...values,
              { value: "", kind: nextKind ?? ("other" as K) },
            ]);
          }}
          className={LINK}
        >
          + {addLabel}
        </button>
        {full && limit !== undefined && (
          <span className={HINT}>{c.atMost(limit)}</span>
        )}
      </div>
    </fieldset>
  );
}

function AddressList({
  addresses,
  capabilities,
  kindName,
  onChange,
}: {
  addresses: readonly PostalAddress[];
  capabilities: ContactCapabilities;
  kindName: (kind: string) => string;
  onChange: (addresses: PostalAddress[]) => void;
}) {
  const t = useT();
  const c = t.contacts;
  const used = new Set(addresses.map((address) => address.kind));
  const free = capabilities.addressKinds.filter(
    (kind) => !capabilities.oneAddressPerKind || !used.has(kind),
  );
  const change = (index: number, patch: Partial<PostalAddress>) => {
    onChange(
      addresses.map((address, at) =>
        at === index ? { ...address, ...patch } : address,
      ),
    );
  };
  const parts = [
    ["street", c.street],
    ["postalCode", c.postalCode],
    ["city", c.city],
    ["region", c.region],
    ["country", c.country],
  ] as const;
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-semibold">{c.address}</legend>
      {addresses.map((address, index) => (
        <div
          key={index}
          className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
        >
          <div className="flex items-center gap-2">
            <select
              aria-label={c.kind(c.address)}
              value={
                address.label === undefined
                  ? address.kind
                  : `label:${address.label}`
              }
              onChange={(event) => {
                const { label: _label, ...rest } = address;
                onChange(
                  addresses.map((other, at) =>
                    at === index
                      ? { ...rest, kind: event.target.value as ValueKind }
                      : other,
                  ),
                );
              }}
              className={CONTROL}
            >
              {address.label !== undefined && (
                <option value={`label:${address.label}`}>
                  {address.label}
                </option>
              )}
              {capabilities.addressKinds.map((kind) => (
                <option
                  key={kind}
                  value={kind}
                  disabled={
                    kind !== address.kind &&
                    capabilities.oneAddressPerKind &&
                    used.has(kind)
                  }
                >
                  {kindName(kind)}
                </option>
              ))}
            </select>
            <div className="flex-1" />
            <IconButton
              label={c.remove(c.address)}
              icon="x"
              onClick={() => {
                onChange(addresses.filter((_, at) => at !== index));
              }}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {parts.map(([part, label]) => (
              <input
                key={part}
                aria-label={label}
                placeholder={label}
                value={address[part]}
                onChange={(event) => {
                  change(index, { [part]: event.target.value });
                }}
                className={`${part === "street" ? "sm:col-span-2" : ""} ${FIELD}`}
              />
            ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        disabled={free.length === 0}
        onClick={() => {
          onChange([
            ...addresses,
            { ...EMPTY_ADDRESS, kind: free[0] ?? "home" },
          ]);
        }}
        className={LINK}
      >
        + {c.addAddress}
      </button>
    </fieldset>
  );
}

function BirthdayField({
  value,
  yearRequired,
  onChange,
}: {
  value: ContactFields["birthday"];
  yearRequired: boolean;
  onChange: (birthday: ContactFields["birthday"]) => void;
}) {
  const t = useT();
  const c = t.contacts;
  const id = useId();
  const months = useMemo(() => {
    const format = new Intl.DateTimeFormat(t.locale, {
      month: "long",
      timeZone: "UTC",
    });
    return Array.from({ length: 12 }, (_, month) =>
      format.format(new Date(Date.UTC(2000, month, 1))),
    );
  }, [t.locale]);
  // Day, month and year are chosen one after another: kept until complete.
  const [day, setDay] = useState(value?.day ?? 0);
  const [month, setMonth] = useState(value?.month ?? 0);
  const [year, setYear] = useState(
    value?.year === undefined ? "" : String(value.year),
  );
  const set = (patch: { month?: number; day?: number; year?: string }) => {
    const nextMonth = patch.month ?? month;
    const nextDay = patch.day ?? day;
    const typed = patch.year ?? year;
    setMonth(nextMonth);
    setDay(nextDay);
    setYear(typed);
    if (!nextMonth || !nextDay) {
      onChange(undefined);
      return;
    }
    const parsed = Number(typed);
    onChange({
      month: nextMonth,
      day: nextDay,
      ...(typed.trim() && Number.isInteger(parsed) && parsed > 0
        ? { year: parsed }
        : {}),
    });
  };
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-semibold">{c.birthday}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={c.day}
          value={day}
          onChange={(event) => {
            set({ day: Number(event.target.value) });
          }}
          className={CONTROL}
        >
          <option value={0}>{c.day}</option>
          {Array.from({ length: 31 }, (_, day) => (
            <option key={day} value={day + 1}>
              {day + 1}
            </option>
          ))}
        </select>
        <select
          aria-label={c.month}
          value={month}
          onChange={(event) => {
            set({ month: Number(event.target.value) });
          }}
          className={CONTROL}
        >
          <option value={0}>{c.month}</option>
          {months.map((name, month) => (
            <option key={name} value={month + 1}>
              {name}
            </option>
          ))}
        </select>
        <input
          id={`${id}-year`}
          aria-label={c.year}
          placeholder={c.year}
          inputMode="numeric"
          value={year}
          onChange={(event) => {
            set({ year: event.target.value.replace(/\D/g, "").slice(0, 4) });
          }}
          className={`w-24 ${CONTROL}`}
        />
        {(day > 0 || month > 0 || year) && (
          <button
            type="button"
            onClick={() => {
              setDay(0);
              setMonth(0);
              setYear("");
              onChange(undefined);
            }}
            className={LINK}
          >
            {c.remove(c.birthday)}
          </button>
        )}
      </div>
      {yearRequired && value && value.year === undefined && (
        <p className={HINT}>{c.yearRequired}</p>
      )}
    </fieldset>
  );
}
