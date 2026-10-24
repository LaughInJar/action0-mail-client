import { useMemo, type CSSProperties } from "react";
import type { PlacedEvent } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { buildMailDocument } from "../../security/mailDocument";
import { sanitizeMailHtml } from "../../security/sanitize";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { SafeHtmlFrame } from "../reader/SafeHtmlFrame";
import { titleOf, whenText } from "./format";
import { RsvpButtons } from "./RsvpButtons";

/**
 * An event in full: when (and the zone it was planned in), where, the
 * meeting link, the description (sanitized, in the mail frame), organizer
 * and guests with their answers, and the answer buttons for invitations.
 */
export function EventDetails({
  placed,
  onClose,
  onEdit,
  onDelete,
}: {
  placed: PlacedEvent;
  onClose: () => void;
  /** It's yours to change: Edit and Delete show. */
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const c = t.calendar;
  const { event, calendar, source } = placed;
  const title = titleOf(event, t);
  const zone = "dateTime" in event.start ? event.start.timeZone : undefined;
  const ownZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const html = event.description?.html;
  const doc = useMemo(
    () =>
      html === undefined
        ? undefined
        : buildMailDocument(sanitizeMailHtml(html).html, {
            allowRemoteContent: false,
          }),
    [html],
  );
  const guests = event.attendees.filter((attendee) => !attendee.resource);

  return (
    <article
      aria-label={title}
      className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950"
      style={{ "--event-color": calendar.color } as CSSProperties}
    >
      <div className="flex items-start gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
        <span
          aria-hidden="true"
          className="mt-1.5 size-3 shrink-0 rounded-sm bg-[var(--event-color)]"
        />
        <h2
          className={`min-w-0 flex-1 text-lg leading-snug font-semibold ${event.status === "cancelled" ? "line-through" : ""}`}
        >
          {title}
        </h2>
        {onEdit && (
          <IconButton label={t.common.edit} icon="pencil" onClick={onEdit} />
        )}
        {onDelete && (
          <IconButton label={t.common.delete} icon="trash" onClick={onDelete} />
        )}
        <IconButton label={c.closeEvent} icon="x" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        <div className="flex gap-3">
          <Icon name="clock" className="mt-0.5 size-4 shrink-0 text-zinc-500" />
          <div>
            <p>{whenText(event, t)}</p>
            {zone && zone !== ownZone && (
              <p className="text-xs text-zinc-500">{c.plannedIn(zone)}</p>
            )}
            {event.recurring && (
              <p className="flex items-center gap-1 text-xs text-zinc-500">
                <Icon name="repeat" className="size-3" />
                {c.repeats}
              </p>
            )}
            {event.status === "cancelled" && (
              <p className="text-xs font-medium text-red-700 dark:text-red-400">
                {c.cancelled}
              </p>
            )}
            {event.status === "tentative" && (
              <p className="text-xs text-zinc-500">{c.tentativeEvent}</p>
            )}
          </div>
        </div>

        {event.location && (
          <div className="flex gap-3">
            <Icon
              name="map-pin"
              className="mt-0.5 size-4 shrink-0 text-zinc-500"
            />
            <a
              href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(event.location)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
              aria-label={`${c.location}: ${event.location}`}
            >
              {event.location}
            </a>
          </div>
        )}

        {event.meetingUrl && /^https:\/\//i.test(event.meetingUrl) && (
          <a
            href={event.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 pointer-coarse:min-h-11"
          >
            <Icon name="video" className="size-4" />
            {c.join}
          </a>
        )}

        {event.myResponse !== undefined && source.provider.canRespond && (
          <RsvpButtons source={source} event={event} />
        )}

        {(event.organizer !== undefined || guests.length > 0) && (
          <div className="flex gap-3">
            <Icon
              name="users"
              className="mt-0.5 size-4 shrink-0 text-zinc-500"
            />
            <div className="min-w-0 flex-1">
              {guests.length > 0 && (
                <p className="font-medium">{c.guests(guests.length)}</p>
              )}
              <ul className="mt-1 space-y-1">
                {event.organizer && (
                  <li className="truncate">
                    {event.organizer.name ?? event.organizer.address}
                    <span className="text-xs text-zinc-500">
                      {" "}
                      · {c.organizer}
                    </span>
                  </li>
                )}
                {guests
                  .filter(
                    (guest) =>
                      guest.address.address.toLowerCase() !==
                      event.organizer?.address.toLowerCase(),
                  )
                  .map((guest) => (
                    <li key={guest.address.address} className="truncate">
                      {guest.address.name ?? guest.address.address}
                      <span className="text-xs text-zinc-500">
                        {" "}
                        · {c.responses[guest.response]}
                        {guest.optional ? ` · ${c.optional}` : ""}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          </div>
        )}

        {doc !== undefined && (
          <section aria-label={c.description}>
            <SafeHtmlFrame srcDoc={doc} title={c.description} />
          </section>
        )}
        {doc === undefined && event.description?.text && (
          <p className="break-words whitespace-pre-wrap">
            {event.description.text}
          </p>
        )}

        <p className="flex items-center gap-2 text-xs text-zinc-500">
          <Icon name="calendar" className="size-3.5" />
          {c.calendarLine(calendar.name, source.label)}
        </p>
        {event.webLink && /^https:\/\//i.test(event.webLink) && (
          <a
            href={event.webLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline dark:text-blue-300"
          >
            <Icon name="external-link" className="size-3.5" />
            {c.openOriginal}
          </a>
        )}
      </div>
    </article>
  );
}
