import { useId, useRef, type ReactNode } from "react";
import type { ContactSnapshot, Typed } from "../../core/contacts";
import type { ContactRow } from "../../data/contacts";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { copyText } from "../common/clipboard";
import { BUTTON, PRIMARY } from "../common/formStyles";
import { Icon, type IconName } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { belowElement } from "../common/menuPosition";
import { useComposeActions } from "../composer/useComposeActions";
import type { Breakpoint } from "../layout/useBreakpoint";
import { ContactAvatar } from "./ContactAvatar";
import { addressLines, formatBirthday } from "./format";
import { useShowMail } from "./useShowMail";

/** A web address to open (`example.com` → `https://example.com`). */
const urlOf = (value: string) =>
  /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;

/**
 * The open contact: picture, name and work, then every value with what it
 * offers (write, copy, call, open). A screen of its own on phones.
 */
export function ContactDetails({
  row,
  snapshot,
  breakpoint,
  canEdit,
  onClose,
  onEdit,
  onDelete,
  onAddOther,
  onMenu,
}: {
  row: ContactRow;
  snapshot: ContactSnapshot | undefined;
  breakpoint: Breakpoint;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddOther: () => void;
  onMenu: (at: MenuPosition) => void;
}) {
  const t = useT();
  const c = t.contacts;
  const id = useId();
  const store = useUiStore();
  const platform = usePlatform();
  const compose = useComposeActions();
  const showMail = useShowMail();
  const moreRef = useRef<HTMLDivElement>(null);
  const { contact, source } = row;
  const accountId = source.accountId;
  const firstEmail = contact.emails[0]?.value;
  const kindOf = (value: Typed<string>) =>
    value.label ??
    (value.kind in c.kinds ? c.kinds[value.kind as keyof typeof c.kinds] : "");
  const work = [
    contact.organization.title,
    contact.organization.department,
    contact.organization.company,
  ]
    .filter((part) => part && part !== row.name)
    .join(" · ");
  const groups = contact.groupIds.flatMap(
    (groupId) => snapshot?.groups.find((group) => group.id === groupId) ?? [],
  );
  const book = snapshot?.addressBooks.find(
    (candidate) => candidate.id === contact.addressBookId,
  );
  const books = snapshot?.addressBooks.length ?? 0;

  return (
    <section
      aria-labelledby={`${id}-name`}
      className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
        <IconButton
          label={breakpoint === "wide" ? c.close : c.back}
          icon={breakpoint === "wide" ? "x" : "arrow-left"}
          onClick={onClose}
        />
        <div className="flex-1" />
        {canEdit && (
          <>
            <IconButton label={c.edit} icon="pencil" onClick={onEdit} />
            <IconButton label={c.delete} icon="trash" onClick={onDelete} />
          </>
        )}
        <div ref={moreRef}>
          <IconButton
            label={c.moreFor(row.name || c.unnamed)}
            icon="more"
            onClick={() => {
              if (moreRef.current) onMenu(belowElement(moreRef.current));
            }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-24">
        <div className="flex items-center gap-4">
          <ContactAvatar
            source={source}
            contact={contact}
            name={row.name}
            large
            fetch
          />
          <div className="min-w-0">
            <h2 id={`${id}-name`} className="text-xl font-semibold break-words">
              {row.name || c.unnamed}
            </h2>
            {work && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{work}</p>
            )}
            {groups.length > 0 && (
              <ul aria-label={c.groups} className="mt-1 flex flex-wrap gap-1">
                {groups.map((group) => (
                  <li
                    key={group.id}
                    className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                  >
                    {group.color && (
                      <span
                        aria-hidden="true"
                        style={{ backgroundColor: group.color }}
                        className="mr-1 inline-block size-2 rounded-full"
                      />
                    )}
                    {group.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {contact.other && (
          <div className="mt-4 space-y-2 rounded-lg bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
            <p>{c.fromOther}</p>
            <button type="button" onClick={onAddOther} className={PRIMARY}>
              {c.addToContacts}
            </button>
          </div>
        )}

        {firstEmail && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                compose.composeTo(accountId, [
                  {
                    address: firstEmail,
                    ...(row.name ? { name: row.name } : {}),
                  },
                ]);
              }}
              className={`${PRIMARY} inline-flex items-center gap-1.5`}
            >
              <Icon name="mail" className="size-4" />
              {c.writeMail}
            </button>
            <button
              type="button"
              onClick={() => {
                void showMail(firstEmail, accountId);
              }}
              className={`${BUTTON} inline-flex items-center gap-1.5`}
            >
              <Icon name="search" className="size-4" />
              {c.showMail}
            </button>
          </div>
        )}

        <dl className="mt-5 space-y-4">
          {contact.emails.length > 0 && (
            <Field icon="mail" label={c.email}>
              {contact.emails.map((email, index) => (
                <Value
                  key={`${email.value}-${String(index)}`}
                  kind={kindOf(email)}
                  copyLabel={c.copy(email.value)}
                  onCopy={() => {
                    copyText(email.value, store, t);
                  }}
                >
                  <button
                    type="button"
                    title={c.writeTo(email.value)}
                    onClick={() => {
                      compose.composeTo(accountId, [
                        {
                          address: email.value,
                          ...(row.name ? { name: row.name } : {}),
                        },
                      ]);
                    }}
                    className="text-left break-all text-blue-700 hover:underline dark:text-blue-300"
                  >
                    {email.value}
                  </button>
                </Value>
              ))}
            </Field>
          )}
          {contact.phones.length > 0 && (
            <Field icon="phone" label={c.phone}>
              {contact.phones.map((phone, index) => (
                <Value
                  key={`${phone.value}-${String(index)}`}
                  kind={kindOf(phone)}
                  copyLabel={c.copy(phone.value)}
                  onCopy={() => {
                    copyText(phone.value, store, t);
                  }}
                >
                  <a
                    href={`tel:${phone.value.replace(/[^\d+*#,;]/g, "")}`}
                    title={c.call(phone.value)}
                    className="text-blue-700 hover:underline dark:text-blue-300"
                  >
                    {phone.value}
                  </a>
                </Value>
              ))}
            </Field>
          )}
          {contact.addresses.length > 0 && (
            <Field icon="map-pin" label={c.address}>
              {contact.addresses.map((address, index) => {
                const lines = addressLines(address);
                return (
                  <Value
                    key={`${lines.join()}-${String(index)}`}
                    kind={kindOf({ value: "", ...address })}
                    copyLabel={c.copy(lines.join(", "))}
                    onCopy={() => {
                      copyText(lines.join("\n"), store, t);
                    }}
                  >
                    <span className="whitespace-pre-line">
                      {lines.join("\n")}
                    </span>
                  </Value>
                );
              })}
            </Field>
          )}
          {contact.birthday && (
            <Field icon="gift" label={c.birthday}>
              <Value>{formatBirthday(contact.birthday, t.locale)}</Value>
            </Field>
          )}
          {contact.websites.length > 0 && (
            <Field icon="globe" label={c.website}>
              {contact.websites.map((site, index) => (
                <Value
                  key={`${site.value}-${String(index)}`}
                  kind={kindOf(site)}
                >
                  <button
                    type="button"
                    onClick={() => {
                      platform.openExternal(urlOf(site.value));
                    }}
                    className="text-left break-all text-blue-700 hover:underline dark:text-blue-300"
                  >
                    {site.value}
                  </button>
                </Value>
              ))}
            </Field>
          )}
          {contact.nickname && (
            <Field icon="user" label={c.nickname}>
              <Value>{contact.nickname}</Value>
            </Field>
          )}
          {contact.notes && (
            <Field icon="file" label={c.notes}>
              <Value>
                <span className="whitespace-pre-wrap">{contact.notes}</span>
              </Value>
            </Field>
          )}
          {(books > 1 || source.kind === "server") && book && (
            <Field icon="book" label={c.addressBook}>
              <Value>{book.name}</Value>
            </Field>
          )}
        </dl>
        <p className="mt-6 text-xs text-zinc-500">{source.label}</p>
      </div>
    </section>
  );
}

function Field({
  icon,
  label,
  children,
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <Icon
        name={icon}
        className="mt-0.5 size-4 shrink-0 text-zinc-500 dark:text-zinc-400"
      />
      <div className="min-w-0 flex-1">
        <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {label}
        </dt>
        {children}
      </div>
    </div>
  );
}

function Value({
  kind,
  copyLabel,
  onCopy,
  children,
}: {
  kind?: string;
  copyLabel?: string;
  onCopy?: () => void;
  children: ReactNode;
}) {
  return (
    <dd className="flex items-start gap-2 text-sm">
      <div className="min-w-0 flex-1 py-0.5">
        {children}
        {kind && (
          <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
            {kind}
          </span>
        )}
      </div>
      {copyLabel && onCopy && (
        <button
          type="button"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={onCopy}
          className="grid size-7 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:size-11"
        >
          <Icon name="copy" className="size-3.5" />
        </button>
      )}
    </dd>
  );
}
