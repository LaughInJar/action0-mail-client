import type { Repeat } from "../core/calendar";
import type { EmailAddress } from "../core/model";

/**
 * What the event editor shows, in the browser's time zone. Kept in the UI
 * store while editing, so Back can ask before throwing changes away.
 */
export interface EventFormValues {
  /** The calendar, as `<source>|<calendar>`. */
  readonly calendar: string;
  readonly title: string;
  readonly allDay: boolean;
  /** "YYYY-MM-DD". */
  readonly startDate: string;
  /** "HH:MM" (unused for all-day events). */
  readonly startTime: string;
  /** "YYYY-MM-DD"; the last day for all-day events. */
  readonly endDate: string;
  readonly endTime: string;
  readonly location: string;
  readonly descriptionHtml: string;
  readonly guests: readonly EmailAddress[];
  readonly videoCall: boolean;
  readonly repeat: "none" | Repeat["kind"];
  /** Last day of the repeats, "YYYY-MM-DD"; "" for never. */
  readonly until: string;
  /** Reminders, minutes before the start. */
  readonly reminders: readonly number[];
}

/** The open editor's values. */
export interface EventFormState {
  /** Which editor they belong to (the route's event, or "new"). */
  readonly key: string;
  readonly values: EventFormValues;
  /** Changed since the editor opened. */
  readonly dirty: boolean;
}

/** One answer of a {@link QuestionState}. */
export interface QuestionOption {
  readonly value: string;
  readonly label: string;
  /** Shown under the label. */
  readonly description?: string;
  /** `primary` is the suggested answer (blue), `danger` destroys something (red); plain by default. */
  readonly tone?: "primary" | "danger";
}

/** A question with several answers (plus Cancel, which comes first and has focus). */
export interface QuestionState {
  readonly title: string;
  readonly message?: string;
  /** A page to read more (opens outside the app). */
  readonly link?: { readonly label: string; readonly href: string };
  /** The answers, the most likely one first (shown on top, or rightmost). */
  readonly options: readonly QuestionOption[];
  /** "Cancel" by default. */
  readonly cancelLabel?: string;
  /** Called with the chosen value, or `null` for Cancel. */
  readonly resolve: (value: string | null) => void;
}
