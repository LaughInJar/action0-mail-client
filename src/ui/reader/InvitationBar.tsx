import { useState, type ReactNode } from "react";
import type { AccountId } from "../../core/ids";
import type { Message } from "../../core/model";
import {
  useCalendarData,
  useCalendarSources,
  useInvitation,
  useSourceState,
} from "../../data/calendar";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import { addDays, dayKey, parseDay, spanOf } from "../calendar/dates";
import { titleOf, whenText } from "../calendar/format";
import { RsvpButtons } from "../calendar/RsvpButtons";
import { errorMessage } from "../common/errorMessage";
import { Icon } from "../common/Icon";

/**
 * Above an invitation mail: the event as your calendar has it, the answer
 * buttons, and what else is planned at that time. Cancellations and
 * answers to your own invitations just say so.
 */
export function InvitationBar({
  accountId,
  message,
}: {
  accountId: AccountId;
  message: Message;
}) {
  const invitation = message.invitation;
  if (!invitation) return null;
  return (
    <InvitationContent
      accountId={accountId}
      uid={invitation.uid}
      method={invitation.method}
    />
  );
}

function InvitationContent({
  accountId,
  uid,
  method,
}: {
  accountId: AccountId;
  uid: string;
  method: "request" | "cancel" | "reply";
}) {
  const t = useT();
  const c = t.calendar;
  const store = useUiStore();
  const source = useCalendarSources().find(
    (candidate) => candidate.accountId === accountId,
  );
  const { access } = useSourceState(source);
  const { data: event, isPending } = useInvitation(
    method === "request" ? source : undefined,
    uid,
  );
  const [allowing, setAllowing] = useState(false);

  let body: ReactNode;
  if (method === "cancel") body = <p>{c.invitationCancelled}</p>;
  else if (method === "reply") body = <p>{c.invitationReply}</p>;
  else if (!source) return null;
  else if (access === "missing")
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1">{c.allowToAnswer}</p>
        <button
          type="button"
          disabled={allowing}
          onClick={() => {
            setAllowing(true);
            source.provider.requestAccess().then(
              () => {
                setAllowing(false);
              },
              (cause: unknown) => {
                setAllowing(false);
                store.getState().showToast({
                  message: errorMessage(cause, t),
                  tone: "error",
                });
              },
            );
          }}
          className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60 pointer-coarse:min-h-11"
        >
          {c.allowCalendar}
        </button>
      </div>
    );
  else if (isPending) body = <p className="text-zinc-500">{c.lookingUp}</p>;
  else if (!event) body = <p>{c.notInCalendar}</p>;
  else
    body = (
      <div className="space-y-2">
        <p>
          <span className="font-semibold">{titleOf(event, t)}</span>
          {" · "}
          {whenText(event, t)}
        </p>
        <Clashes
          eventId={event.id}
          uid={uid}
          start={spanOf(event).start}
          end={spanOf(event).end}
        />
        {source.provider.canRespond && event.myResponse !== undefined && (
          <RsvpButtons source={source} event={event} />
        )}
      </div>
    );

  return (
    <section
      aria-label={c.invitation}
      className="mx-4 mt-3 flex gap-3 rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-sm sm:mx-6 dark:border-blue-900 dark:bg-blue-950/40"
    >
      <Icon
        name="calendar"
        className="mt-0.5 size-4 shrink-0 text-blue-700 dark:text-blue-300"
      />
      <div className="min-w-0 flex-1">{body}</div>
    </section>
  );
}

/** What else is planned at the event's time (in any ticked calendar). */
function Clashes({
  eventId,
  uid,
  start,
  end,
}: {
  eventId: string;
  uid: string;
  start: number;
  end: number;
}) {
  const t = useT();
  // The local day of the event.
  const day = parseDay(dayKey(new Date(start)));
  const { events, pending } = useCalendarData({
    from: day.toISOString(),
    to: addDays(day, 1).toISOString(),
  });
  if (pending && events.length === 0) return null;
  const clashes = events.filter(({ event }) => {
    if (event.id === eventId || event.uid === uid) return false;
    if (event.myResponse === "declined" || "date" in event.start) return false;
    const span = spanOf(event);
    return span.start < end && span.end > start;
  });
  return (
    <p className="text-xs text-zinc-600 dark:text-zinc-400">
      {clashes.length > 0
        ? t.calendar.clashes(
            clashes.map(({ event }) => titleOf(event, t)).join(", "),
          )
        : t.calendar.noClash}
    </p>
  );
}
