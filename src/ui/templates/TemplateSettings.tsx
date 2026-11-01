import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccounts } from "../../accounts/context";
import type { MailTemplate } from "../../compose/templates";
import { asAccountId } from "../../core/ids";
import { useT } from "../../i18n/context";
import {
  useRouter,
  useSettingsEditor,
  useUi,
  useUiStore,
} from "../../state/context";
import { BUTTON, FIELD, HINT, PRIMARY } from "../common/formStyles";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { useAsk } from "../common/useAsk";
import { useSaveShortcut } from "../common/useSaveShortcut";
import { RichTextEditor } from "../composer/RichTextEditor";
import { TEMPLATE_SETTINGS_ID, takeTemplateScroll } from "./templateLink";

/** Which template the editor is open for (`null`: a new one). */
type Editing = { readonly template: MailTemplate | null } | null;

/**
 * Settings → Writing → Templates: the list (name, account, subject) with
 * ↑/↓, Edit and Delete (undoable), and New template. The editor is a
 * dialog in the URL (`?settings=template`), so Back closes it (and asks
 * when there are changes).
 */
export function TemplateSettings() {
  const t = useT();
  const p = t.templates;
  const store = useUiStore();
  const router = useRouter();
  const ask = useAsk();
  const accounts = useAccounts();
  const templates = useUi((state) => state.settings.templates);
  const routerEditor = useSettingsEditor();
  const [editing, setEditing] = useState<Editing>(null);
  /** The editor was opened here (the state may not show it yet). */
  const opened = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    if (takeTemplateScroll())
      document
        .getElementById(TEMPLATE_SETTINGS_ID)
        ?.scrollIntoView({ block: "start" });
  }, []);

  const set = (next: readonly MailTemplate[]) => {
    store.getState().updateSettings({ templates: next });
  };
  const open = (template: MailTemplate | null) => {
    dirty.current = false;
    opened.current = true;
    setEditing({ template });
    router.openSettingsEditor("template");
  };
  const close = () => {
    dirty.current = false;
    opened.current = false;
    setEditing(null);
    router.closeSettingsEditor();
  };
  const discard = () =>
    ask({
      title: p.discardTitle,
      message: p.discardMessage,
      cancelLabel: p.keepEditing,
      options: [{ value: "discard", label: p.discard, tone: "danger" }],
    });
  const cancel = () => {
    if (!dirty.current) {
      close();
      return;
    }
    void discard().then((answer) => {
      if (answer !== null) close();
    });
  };

  // Back takes the editor out of the URL first: with changes, it comes back and asks.
  const shown = useRef(routerEditor);
  useEffect(() => {
    const before = shown.current;
    shown.current = routerEditor;
    if (editing && before === "template" && routerEditor !== "template") {
      if (!dirty.current) {
        opened.current = false;
        setEditing(null);
        return;
      }
      router.openSettingsEditor("template");
      void discard().then((answer) => {
        if (answer === null) return;
        dirty.current = false;
        opened.current = false;
        setEditing(null);
        router.closeSettingsEditor();
      });
    } else if (!opened.current && routerEditor === "template") {
      // Reloaded or gone forward to an editor whose contents are gone.
      router.closeSettingsEditor();
    }
    // Only when the URL's editor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerEditor]);

  const move = (index: number, by: -1 | 1) => {
    const next = [...templates];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(index + by, 0, moved);
    set(next);
  };
  const remove = (template: MailTemplate) => {
    const before = templates;
    set(templates.filter((candidate) => candidate.id !== template.id));
    store.getState().showToast({
      message: p.deleted(template.name),
      tone: "info",
      revert: () => {
        set(before);
      },
    });
  };
  const accountOf = (template: MailTemplate) =>
    template.accountId === undefined
      ? p.forAll
      : (accounts.find((handle) => handle.account.id === template.accountId)
          ?.account.email ?? template.accountId);

  return (
    <div id={TEMPLATE_SETTINGS_ID} className="scroll-mt-4 space-y-3">
      <div>
        <h4 className="text-sm font-medium">{p.section}</h4>
        <p className={HINT}>{p.sectionHint}</p>
      </div>
      {templates.length > 0 && (
        <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {templates.map((template, index) => (
            <li
              key={template.id}
              aria-label={template.name}
              className="flex items-center gap-1 px-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {template.name}
                </div>
                <div className="truncate text-xs text-zinc-500">
                  {[accountOf(template), template.subject]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <IconButton
                label={p.moveUp}
                icon="chevron-up"
                disabled={index === 0}
                onClick={() => {
                  move(index, -1);
                }}
              />
              <IconButton
                label={p.moveDown}
                icon="chevron-down"
                disabled={index === templates.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
              />
              <IconButton
                label={`${p.edit}: ${template.name}`}
                icon="pencil"
                onClick={() => {
                  open(template);
                }}
              />
              <IconButton
                label={`${p.delete}: ${template.name}`}
                icon="trash"
                onClick={() => {
                  remove(template);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => {
          open(null);
        }}
        className={BUTTON}
      >
        {p.newTemplate}
      </button>
      {/* On the page itself: Settings is a dialog with its own focus trap. */}
      {editing &&
        createPortal(
          <TemplateEditor
            template={editing.template}
            onDirty={(value) => {
              dirty.current = value;
            }}
            onCancel={cancel}
            onSave={(template) => {
              set(
                editing.template
                  ? templates.map((candidate) =>
                      candidate.id === template.id ? template : candidate,
                    )
                  : [...templates, template],
              );
              close();
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function TemplateEditor({
  template,
  onDirty,
  onCancel,
  onSave,
}: {
  template: MailTemplate | null;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
  onSave: (template: MailTemplate) => void;
}) {
  const t = useT();
  const p = t.templates;
  const id = useId();
  const accounts = useAccounts();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [html, setHtml] = useState(template?.html ?? "");
  const [account, setAccount] = useState<string>(template?.accountId ?? "");
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== (template?.name ?? "") ||
    subject !== (template?.subject ?? "") ||
    html !== (template?.html ?? "") ||
    account !== (template?.accountId ?? "");
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const save = () => {
    if (!name.trim()) {
      setError(p.needsName);
      return;
    }
    onSave({
      id: template?.id ?? crypto.randomUUID(),
      name: name.trim(),
      subject: subject.trim(),
      html,
      ...(account ? { accountId: asAccountId(account) } : {}),
    });
  };
  useSaveShortcut(formRef, save);

  return (
    <Sheet labelledBy={`${id}-title`} onEscape={onCancel} size="page">
      <form
        ref={formRef}
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-2 pr-2 pl-4 dark:border-zinc-800">
          <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">
            {template ? p.editTemplate : p.newTemplate}
          </h2>
          <IconButton label={p.cancel} icon="x" onClick={onCancel} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label
                htmlFor={`${id}-name`}
                className="block text-sm font-medium"
              >
                {p.name}
              </label>
              <input
                id={`${id}-name`}
                data-initial-focus
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                className={FIELD}
              />
            </div>
            {accounts.length > 1 && (
              <div className="space-y-1">
                <label
                  htmlFor={`${id}-account`}
                  className="block text-sm font-medium"
                >
                  {p.account}
                </label>
                <select
                  id={`${id}-account`}
                  value={account}
                  onChange={(event) => {
                    setAccount(event.target.value);
                  }}
                  className={FIELD}
                >
                  <option value="">{p.forAll}</option>
                  {accounts.map((handle) => (
                    <option key={handle.account.id} value={handle.account.id}>
                      {handle.account.email}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <label
              htmlFor={`${id}-subject`}
              className="block text-sm font-medium"
            >
              {p.subject}
            </label>
            <input
              id={`${id}-subject`}
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
              }}
              className={FIELD}
            />
            <p className={HINT}>{p.subjectHint}</p>
          </div>
          <div className="flex min-h-48 flex-1 flex-col gap-1">
            <span className="text-sm font-medium">{p.text}</span>
            <div className="flex min-h-48 flex-1 flex-col overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
              <RichTextEditor
                id={`${id}-text`}
                label={p.text}
                initialHtml={html}
                focusOnOpen={false}
                onChange={setHtml}
              />
            </div>
            <p className={HINT}>{p.placeholders}</p>
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
            {p.cancel}
          </button>
          <button type="submit" className={PRIMARY}>
            {p.save}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
