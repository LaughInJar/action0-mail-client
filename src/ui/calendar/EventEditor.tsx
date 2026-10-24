import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { EditableEvent, Repeat } from "../../core/calendar";
import { localZone } from "../../core/timeZones";
import type { SourceStatus } from "../../data/calendar";
import {
  useDefaultCalendar,
  useEventForEdit,
  writableCalendars,
  type WritableCalendar,
} from "../../data/eventEdits";
import { useT } from "../../i18n/context";
import { useUi, useUiStore } from "../../state/context";
import type { EventFormValues } from "../../state/eventForm";
import { errorMessage } from "../common/errorMessage";
import { Icon, type IconName } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { useAsk } from "../common/useAsk";
import { AddressField } from "../composer/AddressField";
import { RichTextEditor } from "../composer/RichTextEditor";
import { parseDay } from "./dates";
import {
  changesOf,
  draftOf,
  formKeyOf,
  type EditorMode,
  endsBeforeStart,
  newValues,
  valuesOf,
  withStart,
} from "./formValues";
import {
  ALL_DAY_REMINDERS,
  reminderChoices,
  reminderLabel,
  TIMED_REMINDERS,
} from "./reminderLabels";
import { useEventActions } from "./useEventActions";

const calendarKey = ({ source, calendar }: WritableCalendar) =>
  `${source.key}|${calendar.id}`;

/**
 * Creates an event or changes one: title, time, repeats, calendar, video
 * call, location, guests and description. Its values live in the UI store
 * while it's open, so leaving with changes can ask first. Ctrl/⌘+Enter
 * saves, Escape cancels.
 */
export function EventEditor({
  mode,
  statuses,
  onClose,
  onDeleted,
}: {
  mode: EditorMode;
  statuses: readonly SourceStatus[];
  /** Leaves the editor (after saving or cancelling). */
  onClose: () => void;
  /** The event was deleted. */
  onDeleted: () => void;
}) {
  const t = useT();
  const c = t.calendar;
  const calendars = writableCalendars(statuses);
  const fallback = useDefaultCalendar(calendars);
  const loaded = useEventForEdit(
    mode.kind === "edit" ? mode.placed : undefined,
  );
  const key = formKeyOf(mode);
  const headingId = useId();

  const ownKey =
    mode.kind === "edit"
      ? `${mode.placed.source.key}|${mode.placed.calendar.id}`
      : fallback
        ? calendarKey(fallback)
        : "";
  const initial =
    mode.kind === "new"
      ? newValues(
          mode.from,
          mode.to,
          ownKey,
          fallback?.calendar.defaultReminders?.slice(
            0,
            fallback.source.provider.maxReminders,
          ),
        )
      : loaded.data
        ? valuesOf(loaded.data.draft, ownKey)
        : undefined;

  let body: ReactNode;
  if (mode.kind === "new" && !fallback)
    body = <p className="p-4 text-sm">{c.noWritableCalendar}</p>;
  else if (mode.kind === "edit" && loaded.error)
    body = (
      <p role="alert" className="p-4 text-sm text-red-700 dark:text-red-400">
        {c.couldntLoadEvent(errorMessage(loaded.error, t))}
      </p>
    );
  else if (!initial)
    body = <p className="p-4 text-sm text-zinc-500">{c.loadingEvent}</p>;
  const form = body === undefined && initial !== undefined;

  return (
    <section
      aria-labelledby={headingId}
      data-own-keys=""
      className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950"
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
        <h2 id={headingId} className="min-w-0 flex-1 text-lg font-semibold">
          {mode.kind === "new" ? c.newEvent : c.editEvent}
        </h2>
        {!form && (
          <IconButton label={t.common.close} icon="x" onClick={onClose} />
        )}
      </div>
      {initial && form ? (
        <Form
          key={key}
          formKey={key}
          mode={mode}
          initial={initial}
          editable={loaded.data}
          calendars={calendars}
          fallback={fallback}
          onClose={onClose}
          onDeleted={onDeleted}
        />
      ) : (
        body
      )}
    </section>
  );
}

const field =
  "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 pointer-coarse:min-h-11";

function Form({
  formKey,
  mode,
  initial,
  editable,
  calendars,
  fallback,
  onClose,
  onDeleted,
}: {
  formKey: string;
  mode: EditorMode;
  /** The values it starts with (unless the store has them already). */
  initial: EventFormValues;
  editable: EditableEvent | undefined;
  calendars: readonly WritableCalendar[];
  fallback: WritableCalendar | undefined;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const c = t.calendar;
  const store = useUiStore();
  const ask = useAsk();
  const actions = useEventActions();
  const form = useUi((state) => state.eventForm);
  const titleRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const ids = {
    title: useId(),
    start: useId(),
    end: useId(),
    repeat: useId(),
    ends: useId(),
    until: useId(),
    calendar: useId(),
    video: useId(),
    location: useId(),
    guests: useId(),
    description: useId(),
    problem: useId(),
  };

  const placed = mode.kind === "edit" ? mode.placed : undefined;
  // The store has the values once the editor opened (and keeps changes).
  const values = form?.key === formKey ? form.values : initial;
  const dirty = form?.key === formKey && form.dirty;

  // Put the starting values into the store (the calendar shows them as a
  // ghost); a new suggested time from the route replaces the times.
  const from = mode.kind === "new" ? mode.from : "";
  const to = mode.kind === "new" ? mode.to : "";
  useEffect(() => {
    const current = store.getState().eventForm;
    if (current?.key !== formKey)
      store
        .getState()
        .setEventForm({ key: formKey, values: initial, dirty: false });
    else if (mode.kind === "new")
      store.getState().setEventForm({
        ...current,
        values: {
          ...current.values,
          allDay: initial.allDay,
          startDate: initial.startDate,
          startTime: initial.startTime,
          endDate: initial.endDate,
          endTime: initial.endTime,
        },
      });
    // Only when the editor opens or the route suggests another time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey, from, to]);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const update = (patch: Partial<EventFormValues>) => {
    store.getState().setEventForm({
      key: formKey,
      values: { ...values, ...patch },
      dirty: true,
    });
  };

  const chosen =
    calendars.find((entry) => calendarKey(entry) === values.calendar) ??
    fallback;
  const calendar = placed?.calendar ?? chosen?.calendar;
  const source = placed?.source ?? chosen?.source;
  const invalid = endsBeforeStart(values);
  const videoCall = calendar?.videoCall;
  const videoFixed = editable?.videoCallFixed === true && values.videoCall;
  const zone =
    editable && "dateTime" in editable.draft.start
      ? editable.draft.start.timeZone
      : undefined;

  const finish = () => {
    store.getState().setEventForm(null);
    onClose();
  };

  const save = async () => {
    if (busy || invalid) return;
    setBusy(true);
    try {
      if (mode.kind === "new") {
        if (!chosen) return;
        const draft = draftOf(values, chosen.calendar.id);
        if (!(await actions.create(chosen.source, draft))) return;
        store
          .getState()
          .updateSettings({ lastEventCalendar: calendarKey(chosen) });
        finish();
        return;
      }
      if (!editable) return;
      const before = editable.draft;
      const after = draftOf(values, before.calendarId, zone ?? localZone());
      const changes = changesOf(before, after);
      if (Object.keys(changes).length === 0) {
        finish();
        return;
      }
      const ok = await actions.update(mode.placed, changes, {
        firstOccurrence: editable.firstOccurrence,
      });
      if (ok) finish();
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (dirty) {
      const answer = await ask({
        title: c.discardTitle,
        message: c.discardMessage,
        cancelLabel: c.keepEditing,
        options: [{ value: "discard", label: c.discard, tone: "danger" }],
      });
      if (answer === null) return;
    }
    finish();
  };

  const remove = async () => {
    if (!placed || busy) return;
    setBusy(true);
    try {
      const ok = await actions.remove(placed, {
        firstOccurrence: editable?.firstOccurrence ?? false,
      });
      if (!ok) return;
      store.getState().setEventForm(null);
      onDeleted();
    } finally {
      setBusy(false);
    }
  };

  // Ctrl/⌘+Enter saves, Escape cancels. Listened for on the document, so
  // fields inside (address suggestions) handle and stop them first.
  const onKeyDown = useRef<(event: globalThis.KeyboardEvent) => void>(
    () => undefined,
  );
  useEffect(() => {
    onKeyDown.current = (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void save();
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        void cancel();
      }
    };
  });
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => {
      if (
        event.target instanceof Node &&
        formRef.current?.contains(event.target)
      )
        onKeyDown.current(event);
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
    };
  }, []);

  const day = parseDay(values.startDate);
  const repeatLabel = (kind: Repeat["kind"]) => {
    const kinds = c.repeatKinds;
    switch (kind) {
      case "daily":
      case "weekdays":
      case "custom":
        return kinds[kind]();
      case "weekly":
        return kinds.weekly(
          new Intl.DateTimeFormat(t.locale, { weekday: "long" }).format(day),
        );
      case "monthly":
        return kinds.monthly(day.getDate());
      case "yearly":
        return kinds.yearly(
          new Intl.DateTimeFormat(t.locale, {
            day: "numeric",
            month: "long",
          }).format(day),
        );
    }
  };
  const kinds: Repeat["kind"][] = [
    "daily",
    "weekdays",
    "weekly",
    "monthly",
    "yearly",
    ...(editable?.draft.repeat?.kind === "custom" ? ["custom" as const] : []),
  ];
  const repeating = values.repeat !== "none" && values.repeat !== "custom";

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        <div>
          <label htmlFor={ids.title} className="sr-only">
            {c.titleLabel}
          </label>
          <input
            ref={titleRef}
            id={ids.title}
            value={values.title}
            placeholder={c.titlePlaceholder}
            autoComplete="off"
            onChange={(event) => {
              update({ title: event.target.value });
            }}
            className="w-full border-b border-zinc-300 bg-transparent px-1 py-1.5 text-lg font-semibold focus:border-blue-500 focus:outline-none dark:border-zinc-700"
          />
        </div>

        <Row icon="clock">
          <label className="flex items-center gap-2 pointer-coarse:min-h-11">
            <input
              type="checkbox"
              checked={values.allDay}
              onChange={(event) => {
                const allDay = event.target.checked;
                // A timed event's default reminders don't fit all day.
                const defaults = (calendar?.defaultReminders ?? [])
                  .slice(0, source?.provider.maxReminders ?? 0)
                  .join();
                update({
                  allDay,
                  ...(allDay && values.reminders.join() === defaults
                    ? { reminders: [] }
                    : !allDay &&
                        mode.kind === "new" &&
                        values.reminders.length === 0
                      ? {
                          reminders: (calendar?.defaultReminders ?? []).slice(
                            0,
                            source?.provider.maxReminders ?? 0,
                          ),
                        }
                      : {}),
                });
              }}
              className="size-4"
            />
            {c.allDay}
          </label>
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">{c.starts}</legend>
            <span aria-hidden="true" className="w-12 text-zinc-500">
              {c.starts}
            </span>
            <input
              id={ids.start}
              type="date"
              aria-label={c.startDate}
              value={values.startDate}
              required
              onChange={(event) => {
                if (event.target.value)
                  update(
                    withStart(values, event.target.value, values.startTime),
                  );
              }}
              className={field}
            />
            {!values.allDay && (
              <input
                type="time"
                step={900}
                aria-label={c.startTime}
                value={values.startTime}
                onChange={(event) => {
                  if (event.target.value)
                    update(
                      withStart(values, values.startDate, event.target.value),
                    );
                }}
                className={field}
              />
            )}
          </fieldset>
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">{c.ends}</legend>
            <span aria-hidden="true" className="w-12 text-zinc-500">
              {c.ends}
            </span>
            <input
              id={ids.end}
              type="date"
              aria-label={c.endDate}
              value={values.endDate}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? ids.problem : undefined}
              onChange={(event) => {
                if (event.target.value) update({ endDate: event.target.value });
              }}
              className={field}
            />
            {!values.allDay && (
              <input
                type="time"
                step={900}
                aria-label={c.endTime}
                value={values.endTime}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? ids.problem : undefined}
                onChange={(event) => {
                  if (event.target.value)
                    update({ endTime: event.target.value });
                }}
                className={field}
              />
            )}
          </fieldset>
          {invalid && (
            <p
              id={ids.problem}
              role="alert"
              className="text-red-700 dark:text-red-400"
            >
              {c.endsBeforeStart}
            </p>
          )}
          {zone && zone !== localZone() && (
            <p className="text-xs text-zinc-500">{c.plannedIn(zone)}</p>
          )}
        </Row>

        <Row icon="repeat">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={ids.repeat} className="sr-only">
              {c.repeatLabel}
            </label>
            <select
              id={ids.repeat}
              value={values.repeat}
              onChange={(event) => {
                update({
                  repeat: event.target.value as EventFormValues["repeat"],
                });
              }}
              className={`${field} max-w-full`}
            >
              <option value="none">{c.repeatNone}</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {repeatLabel(kind)}
                </option>
              ))}
            </select>
          </div>
          {repeating && (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={ids.ends} className="text-zinc-500">
                {c.repeatEnds}
              </label>
              <select
                id={ids.ends}
                value={values.until ? "on" : "never"}
                onChange={(event) => {
                  update({
                    until:
                      event.target.value === "on"
                        ? values.until || values.endDate
                        : "",
                  });
                }}
                className={field}
              >
                <option value="never">{c.endsNever}</option>
                <option value="on">{c.endsOn}</option>
              </select>
              {values.until && (
                <input
                  id={ids.until}
                  type="date"
                  aria-label={c.untilLabel}
                  value={values.until}
                  min={values.startDate}
                  onChange={(event) => {
                    if (event.target.value)
                      update({ until: event.target.value });
                  }}
                  className={field}
                />
              )}
            </div>
          )}
        </Row>

        {(source?.provider.maxReminders ?? 0) > 0 && (
          <Row icon="bell">
            {values.reminders.length === 0 && (
              <p className="py-1.5 text-zinc-500">{c.reminders.none}</p>
            )}
            {values.reminders.map((minutes, index) => {
              const label = reminderLabel(minutes, values.allDay, t);
              return (
                <div key={index} className="flex items-center gap-1">
                  <select
                    aria-label={c.reminders.numbered(index + 1)}
                    value={minutes}
                    onChange={(event) => {
                      const next = [...values.reminders];
                      next[index] = Number(event.target.value);
                      update({ reminders: next });
                    }}
                    className={`${field} max-w-full`}
                  >
                    {reminderChoices(minutes, values.allDay).map((choice) => (
                      <option key={choice} value={choice}>
                        {reminderLabel(choice, values.allDay, t)}
                      </option>
                    ))}
                  </select>
                  <IconButton
                    label={c.reminders.remove(label)}
                    icon="x"
                    onClick={() => {
                      update({
                        reminders: values.reminders.filter(
                          (_, other) => other !== index,
                        ),
                      });
                    }}
                  />
                </div>
              );
            })}
            {values.reminders.length < (source?.provider.maxReminders ?? 0) && (
              <button
                type="button"
                onClick={() => {
                  const presets = values.allDay
                    ? ALL_DAY_REMINDERS
                    : TIMED_REMINDERS;
                  const fresh =
                    presets.find(
                      (minutes) =>
                        minutes !== 0 && !values.reminders.includes(minutes),
                    ) ?? 0;
                  update({ reminders: [...values.reminders, fresh] });
                }}
                className="flex items-center gap-1 rounded-md px-1 py-1 text-blue-700 hover:underline dark:text-blue-300 pointer-coarse:min-h-11"
              >
                <Icon name="plus" className="size-3.5" />
                {c.reminders.add}
              </button>
            )}
          </Row>
        )}

        <Row icon="calendar">
          {mode.kind === "new" ? (
            <>
              <label htmlFor={ids.calendar} className="sr-only">
                {c.calendarLabel}
              </label>
              <select
                id={ids.calendar}
                value={chosen ? calendarKey(chosen) : ""}
                onChange={(event) => {
                  const next = calendars.find(
                    (entry) => calendarKey(entry) === event.target.value,
                  );
                  const defaults = (entry: WritableCalendar | undefined) =>
                    (entry?.calendar.defaultReminders ?? [])
                      .slice(0, entry?.source.provider.maxReminders ?? 0)
                      .join();
                  // Reminders follow the calendar's defaults until changed.
                  const untouched =
                    values.allDay ||
                    values.reminders.join() === defaults(chosen);
                  update({
                    calendar: event.target.value,
                    ...(untouched && !values.allDay
                      ? {
                          reminders: (
                            next?.calendar.defaultReminders ?? []
                          ).slice(0, next?.source.provider.maxReminders ?? 0),
                        }
                      : {}),
                  });
                }}
                className={`${field} max-w-full`}
              >
                {groups(calendars).map(({ label, entries }) => (
                  <optgroup key={label} label={label}>
                    {entries.map((entry) => (
                      <option
                        key={calendarKey(entry)}
                        value={calendarKey(entry)}
                      >
                        {entry.calendar.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </>
          ) : (
            placed && (
              <p className="py-1.5">
                {c.calendarLine(placed.calendar.name, placed.source.label)}
              </p>
            )
          )}
        </Row>

        {videoCall && (
          <Row icon="video">
            <label className="flex items-center gap-2 pointer-coarse:min-h-11">
              <input
                id={ids.video}
                type="checkbox"
                checked={values.videoCall}
                disabled={videoFixed}
                onChange={(event) => {
                  update({ videoCall: event.target.checked });
                }}
                className="size-4"
              />
              {c.videoCalls[videoCall]}
            </label>
            {videoFixed && (
              <p className="text-xs text-zinc-500">{c.teamsFixed}</p>
            )}
          </Row>
        )}

        <Row icon="map-pin">
          <label htmlFor={ids.location} className="sr-only">
            {c.location}
          </label>
          <input
            id={ids.location}
            value={values.location}
            placeholder={c.locationPlaceholder}
            autoComplete="off"
            onChange={(event) => {
              update({ location: event.target.value });
            }}
            className={`${field} w-full`}
          />
        </Row>

        {source?.accountId && (
          <Row icon="users">
            <div className="rounded-md border border-zinc-300 dark:border-zinc-700">
              <AddressField
                id={ids.guests}
                label={c.guestsLabel}
                hideLabel
                placeholder={c.guestsLabel}
                accountId={source.accountId}
                value={values.guests}
                onChange={(guests) => {
                  update({ guests });
                }}
              />
            </div>
            {values.guests.length > 0 &&
              source.provider.guestNotices === "always" && (
                <p className="text-xs text-zinc-500">{c.guestsNotified}</p>
              )}
          </Row>
        )}

        <div className="flex h-40 flex-col overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
          <RichTextEditor
            id={ids.description}
            label={c.description}
            placeholder={c.descriptionPlaceholder}
            initialHtml={values.descriptionHtml}
            focusOnOpen={false}
            onChange={(descriptionHtml) => {
              update({ descriptionHtml });
            }}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-zinc-200 p-3 pb-[calc(0.75rem+var(--safe-bottom))] dark:border-zinc-800">
        {placed && (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-950 pointer-coarse:min-h-11"
          >
            {t.common.delete}
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void cancel()}
          className="rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
        >
          {t.common.cancel}
        </button>
        <button
          type="submit"
          disabled={busy || invalid}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 pointer-coarse:min-h-11"
        >
          {t.common.save}
        </button>
      </div>
    </form>
  );
}

/** A line of the form with its icon. */
function Row({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <Icon name={icon} className="mt-2 size-4 shrink-0 text-zinc-500" />
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

/** Calendars grouped by their account (or subscription). */
function groups(
  calendars: readonly WritableCalendar[],
): { label: string; entries: WritableCalendar[] }[] {
  const byLabel = new Map<string, WritableCalendar[]>();
  for (const entry of calendars) {
    const list = byLabel.get(entry.source.label) ?? [];
    list.push(entry);
    byLabel.set(entry.source.label, list);
  }
  return [...byLabel].map(([label, entries]) => ({ label, entries }));
}
