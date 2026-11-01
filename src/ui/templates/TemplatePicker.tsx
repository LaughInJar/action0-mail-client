import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  fillTemplate,
  recipientNames,
  templateSearchText,
  templatesFor,
  type MailTemplate,
} from "../../compose/templates";
import { fullNameOf, type ContactSnapshot } from "../../core/contacts";
import { contactWithAddress, useContactSources } from "../../data/contacts";
import { queryKeys } from "../../data/keys";
import { useT } from "../../i18n/context";
import { useRouter, useUi, useUiStore } from "../../state/context";
import type { ComposerSession } from "../../state/uiStore";
import { BUTTON, FIELD, LINK, PRIMARY } from "../common/formStyles";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { openTemplateSettings } from "./templateLink";

/**
 * The composer's templates: a searchable list above the text (↑/↓ and
 * Enter insert one at the cursor, Esc closes), "Save as template…" for
 * the text written so far, and "Manage templates" (Settings).
 */
export function TemplatePicker({
  editor,
  session,
  onSubject,
  onClose,
}: {
  editor: Editor | null;
  session: ComposerSession;
  /** Fills the subject (only called while it's empty). */
  onSubject: (subject: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const p = t.templates;
  const id = useId();
  const store = useUiStore();
  const router = useRouter();
  const queryClient = useQueryClient();
  const sources = useContactSources();
  const all = useUi((state) => state.settings.templates);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const needle = query
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
    return templatesFor(all, session.accountId).filter(
      (template) => !needle || templateSearchText(template).includes(needle),
    );
  }, [all, session.accountId, query]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  /** The first recipient's names, from the account's contacts where they're loaded. */
  const names = () => {
    const to = session.to[0];
    const source = sources.find(
      (candidate) => candidate.accountId === session.accountId,
    );
    const contact =
      to && source
        ? contactWithAddress(
            queryClient.getQueryData<ContactSnapshot>(
              queryKeys.contacts(source.key),
            ),
            to.address,
          )
        : undefined;
    return recipientNames(
      to,
      contact
        ? { given: contact.name.given, full: fullNameOf(contact) }
        : undefined,
    );
  };

  const insert = (template: MailTemplate) => {
    if (!editor) return;
    // One step for Ctrl+Z, at the cursor, inside the text only.
    editor
      .chain()
      .focus()
      .insertContent(fillTemplate(template.html, names()))
      .run();
    if (!session.subject.trim() && template.subject.trim())
      onSubject(template.subject);
    onClose();
  };

  const saveAs = () => {
    const name = saving?.trim();
    if (!name) return;
    const template: MailTemplate = {
      id: crypto.randomUUID(),
      name,
      subject: session.subject.trim(),
      html: session.body,
    };
    store.getState().updateSettings({
      templates: [...store.getState().settings.templates, template],
    });
    store.getState().showToast({ message: p.saved(name), tone: "info" });
    onClose();
  };

  if (saving !== null)
    return (
      <form
        aria-label={p.saveAsTitle}
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
        onSubmit={(event) => {
          event.preventDefault();
          saveAs();
        }}
      >
        <label htmlFor={`${id}-name`} className="text-sm font-medium">
          {p.name}
        </label>
        <input
          id={`${id}-name`}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the one field of this step
          autoFocus
          value={saving}
          onChange={(event) => {
            setSaving(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setSaving(null);
            }
          }}
          className={`min-w-0 flex-1 ${FIELD}`}
        />
        <button
          type="button"
          onClick={() => {
            setSaving(null);
          }}
          className={BUTTON}
        >
          {p.cancel}
        </button>
        <button type="submit" disabled={!saving.trim()} className={PRIMARY}>
          {p.save}
        </button>
      </form>
    );

  return (
    <div
      role="dialog"
      aria-label={p.templates}
      className="flex max-h-72 shrink-0 flex-col border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <Icon name="clipboard" className="size-4 shrink-0 text-zinc-500" />
        <input
          ref={searchRef}
          type="search"
          role="combobox"
          aria-label={p.search}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={
            shown[cursor] ? `${id}-${String(cursor)}` : undefined
          }
          placeholder={p.search}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((at) => Math.min(shown.length - 1, at + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((at) => Math.max(0, at - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const chosen = shown[cursor];
              if (chosen) insert(chosen);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              editor?.commands.focus();
            }
          }}
          className={`min-w-0 flex-1 ${FIELD}`}
        />
        <IconButton label={p.close} icon="x" onClick={onClose} />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label={p.templates}
        className="min-h-0 flex-1 overflow-y-auto px-1 py-1"
      >
        {shown.map((template, index) => (
          // The search field's ↑/↓ and Enter are the keyboard's way.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <div
            key={template.id}
            id={`${id}-${String(index)}`}
            role="option"
            tabIndex={-1}
            aria-selected={index === cursor}
            onMouseDown={(event) => {
              // Keep the editor's cursor where it is.
              event.preventDefault();
            }}
            onClick={() => {
              insert(template);
            }}
            className="cursor-pointer rounded-md px-2 py-1.5 text-sm hover:bg-zinc-200/60 aria-selected:bg-blue-100 dark:hover:bg-zinc-800 dark:aria-selected:bg-blue-500/20 pointer-coarse:min-h-11"
          >
            <span className="font-medium">{template.name}</span>
            {template.subject && (
              <span className="ml-2 text-xs text-zinc-500">
                {template.subject}
              </span>
            )}
          </div>
        ))}
        {shown.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-zinc-500">
            {all.length === 0 ? p.none : p.noMatch}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
        <button
          type="button"
          disabled={!session.body.trim()}
          onClick={() => {
            setSaving(session.subject.trim());
          }}
          className={LINK}
        >
          {p.saveAs}
        </button>
        <button
          type="button"
          onClick={() => {
            openTemplateSettings(router);
          }}
          className={LINK}
        >
          {p.manage}
        </button>
      </div>
    </div>
  );
}
