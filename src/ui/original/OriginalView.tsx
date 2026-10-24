import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useAccountHandle } from "../../accounts/context";
import { isMailError } from "../../core/errors";
import type { MessageRef } from "../../core/ids";
import {
  authResults,
  deliveryPath,
  headerValue,
  parseHeaders,
  rawText,
  sourceSegments,
  splitMessage,
  type AuthCheck,
  type Hop,
  type RawHeader,
} from "../../core/rawMessage";
import { useRawMessage } from "../../data/hooks";
import { useT, type I18n } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { useUiStore } from "../../state/context";
import { copyText } from "../common/clipboard";
import { errorMessage } from "../common/errorMessage";
import { formatBytes } from "../common/format";
import { Icon, type IconName } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { emlName } from "./emlName";

/** Props of {@link OriginalView}. */
export interface OriginalViewProps {
  readonly message: MessageRef;
  readonly onClose: () => void;
}

type Tab = "summary" | "headers" | "source";
const TABS: readonly Tab[] = ["summary", "headers", "source"];

/**
 * A message's original: a summary (who sent it, what the receiving server
 * checked, how it travelled), every header, and the source, with Download
 * (.eml) and Copy. A large dialog on desktop, the whole screen on phones.
 * Shown as text only, and kept only while it's open.
 */
export function OriginalView({ message, onClose }: OriginalViewProps) {
  const t = useT();
  const o = t.original;
  const titleId = useId();
  const handle = useAccountHandle(message.accountId);
  const { data, error, refetch } = useRawMessage(
    message.accountId,
    message.messageId,
  );
  const text = useMemo(() => (data ? rawText(data) : undefined), [data]);
  const headers = useMemo(
    () => (text === undefined ? [] : parseHeaders(splitMessage(text).head)),
    [text],
  );
  const [tab, setTab] = useState<Tab>("summary");
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const platform = usePlatform();
  const store = useUiStore();
  const subject = headerValue(headers, "Subject");

  const download = () => {
    if (!data) return;
    platform
      .saveFile(
        new Blob([data.slice()], { type: "message/rfc822" }),
        emlName(subject),
      )
      .catch(() => {
        store.getState().showToast({ message: o.couldntSave, tone: "error" });
      });
  };

  const onTabKey = (event: KeyboardEvent) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next =
      TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] ?? tab;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  let content: ReactNode;
  if (!handle?.provider.capabilities.rawSource)
    content = <Note>{o.couldntLoad}</Note>;
  else if (text !== undefined)
    content =
      tab === "summary" ? (
        <Summary headers={headers} t={t} />
      ) : tab === "headers" ? (
        <Headers headers={headers} t={t} />
      ) : (
        <Source text={text} t={t} />
      );
  else if (error)
    content = (
      <Note>
        {isMailError(error, "not-found")
          ? o.gone
          : `${o.couldntLoad}: ${errorMessage(error, t)}`}{" "}
        {!isMailError(error, "not-found") && (
          <button
            type="button"
            className="text-blue-700 underline dark:text-blue-300"
            onClick={() => void refetch()}
          >
            {t.common.tryAgain}
          </button>
        )}
      </Note>
    );
  else
    content = (
      <Note>
        <span role="status">{o.loading}</span>
      </Note>
    );

  return (
    <Sheet labelledBy={titleId} onEscape={onClose} size="page">
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 py-1.5 pr-2 pl-4 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold">
            {o.title}
          </h2>
          {subject && (
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {subject}
            </p>
          )}
        </div>
        <TextButton
          icon="download"
          label={o.download}
          disabled={!data}
          onClick={download}
        />
        <TextButton
          icon="copy"
          label={o.copy}
          disabled={text === undefined}
          onClick={() => {
            if (text !== undefined) copyText(text, store, t, o.copied);
          }}
        />
        <IconButton label={t.common.close} icon="x" onClick={onClose} />
      </div>
      <div
        role="tablist"
        aria-label={o.tabsLabel}
        className="flex shrink-0 gap-1 border-b border-zinc-200 px-3 dark:border-zinc-800"
      >
        {TABS.map((id) => (
          <button
            key={id}
            ref={(element) => {
              tabRefs.current[id] = element;
            }}
            type="button"
            role="tab"
            id={`${titleId}-${id}`}
            aria-selected={tab === id}
            aria-controls={`${titleId}-panel`}
            tabIndex={tab === id ? 0 : -1}
            data-initial-focus={tab === id ? "" : undefined}
            onClick={() => {
              setTab(id);
            }}
            onKeyDown={onTabKey}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-zinc-600 hover:text-zinc-900 aria-selected:border-blue-600 aria-selected:font-medium aria-selected:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 dark:aria-selected:border-blue-400 dark:aria-selected:text-zinc-100 pointer-coarse:min-h-11"
          >
            {o.tabs[id]}
          </button>
        ))}
      </div>
      <div
        id={`${titleId}-panel`}
        role="tabpanel"
        aria-labelledby={`${titleId}-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset sm:px-6"
      >
        {content}
      </div>
    </Sheet>
  );
}

function TextButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
    >
      <Icon name={icon} className="size-4 shrink-0" />
      <span className="max-sm:sr-only">{label}</span>
    </button>
  );
}

function Note({ children }: { readonly children: ReactNode }) {
  return (
    <p className="py-6 text-sm text-zinc-600 dark:text-zinc-400">{children}</p>
  );
}

/** "3 seconds", "2 minutes" (for "Delivered after …"). */
function duration(ms: number, o: I18n["original"]): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return o.lessThanSecond;
  if (seconds < 60) return o.seconds(seconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return o.minutes(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return o.hours(hours);
  return o.days(Math.round(hours / 24));
}

/** "3 sec", "2 min" (for the delivery path's table). */
function shortDuration(ms: number, locale: string): string {
  const unit = (value: number, name: string) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: name,
      unitDisplay: "short",
    }).format(value);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
}

/** A delay worth noticing: over a minute. */
const SLOW_MS = 60_000;

function Summary({
  headers,
  t,
}: {
  readonly headers: readonly RawHeader[];
  readonly t: I18n;
}) {
  const o = t.original;
  const id = useId();
  const checks = authResults(headers);
  const path = deliveryPath(headers);
  const sent = Date.parse(
    (headerValue(headers, "Date") ?? "").replace(/\([^)]*\)/g, ""),
  );
  const arrived = path.at(-1)?.at;
  const dateTime = new Intl.DateTimeFormat(t.locale, {
    dateStyle: "full",
    timeStyle: "long",
  });
  const rows: [string, ReactNode][] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) rows.push([label, value]);
  };
  add(o.messageId, headerValue(headers, "Message-ID"));
  if (!Number.isNaN(sent))
    rows.push([
      o.createdAt,
      <>
        {dateTime.format(sent)}
        {arrived !== undefined && arrived >= sent && (
          <span className="block text-zinc-500 dark:text-zinc-400">
            {o.deliveredAfter(duration(arrived - sent, o))}
          </span>
        )}
      </>,
    ]);
  add(o.from, headerValue(headers, "From"));
  add(o.to, headerValue(headers, "To"));
  add(o.cc, headerValue(headers, "Cc"));
  add(o.subject, headerValue(headers, "Subject"));

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="pt-1 text-zinc-500 dark:text-zinc-400">{label}</dt>
            <dd className="pb-1 break-words sm:pt-1">{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby={`${id}-checks`}>
        <h3 id={`${id}-checks`} className="text-sm font-semibold">
          {o.authentication}
        </h3>
        <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
          {o.authNote}
        </p>
        {checks.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {o.noChecks}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {checks.map((check, index) => (
              <Check key={index} check={check} o={o} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${id}-path`}>
        <h3 id={`${id}-path`} className="text-sm font-semibold">
          {o.path}
        </h3>
        <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
          {o.pathNote}
        </p>
        {path.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{o.noPath}</p>
        ) : (
          <Path hops={path} t={t} />
        )}
      </section>
    </div>
  );
}

const TONES: Readonly<Record<string, string>> = {
  pass: "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100",
  fail: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100",
  permerror: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100",
  softfail: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
};

function Check({
  check,
  o,
}: {
  readonly check: AuthCheck;
  readonly o: I18n["original"];
}) {
  const tone =
    TONES[check.result] ??
    "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100";
  return (
    <li
      className={`flex items-baseline gap-1.5 rounded-full px-3 py-1 text-sm ${tone}`}
    >
      <span className="font-semibold">{o.methods[check.method]}</span>
      <span>{o.results[check.result] ?? check.result}</span>
      {check.domain && (
        <span className="text-xs opacity-80">
          {o.checkedDomain(check.domain)}
        </span>
      )}
    </li>
  );
}

function Path({
  hops,
  t,
}: {
  readonly hops: readonly Hop[];
  readonly t: I18n;
}) {
  const o = t.original;
  const c = o.columns;
  const time = new Intl.DateTimeFormat(t.locale, {
    dateStyle: "short",
    timeStyle: "medium",
  });
  const delayOf = (hop: Hop) =>
    hop.delay === undefined
      ? o.unknown
      : hop.delay < 0
        ? o.clockSkew
        : shortDuration(hop.delay, t.locale);
  const slow = (hop: Hop) =>
    hop.delay !== undefined && hop.delay > SLOW_MS
      ? "font-semibold text-amber-700 dark:text-amber-300"
      : "";
  return (
    <>
      {/* Phones: one block per hop, too narrow for a table. */}
      <ol className="space-y-2 text-xs sm:hidden">
        {hops.map((hop, index) => (
          <li
            key={index}
            className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
          >
            <p className="font-medium break-all">
              {index + 1}. {hop.from ?? o.unknown} → {hop.by ?? o.unknown}
            </p>
            <p className="text-zinc-600 dark:text-zinc-400">
              {[
                hop.with,
                hop.at === undefined ? undefined : time.format(hop.at),
              ]
                .filter(Boolean)
                .join(" · ")}
              {" · "}
              <span className={slow(hop)}>{delayOf(hop)}</span>
            </p>
          </li>
        ))}
      </ol>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500 dark:text-zinc-400">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                {c.hop}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {c.from}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {c.by}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {c.with}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {c.time}
              </th>
              <th scope="col" className="py-1 font-medium">
                {c.delay}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {hops.map((hop, index) => (
              <tr key={index} className="align-top">
                <td className="py-1 pr-3 tabular-nums">{index + 1}</td>
                <td className="py-1 pr-3 break-all">{hop.from ?? o.unknown}</td>
                <td className="py-1 pr-3 break-all">{hop.by ?? o.unknown}</td>
                <td className="py-1 pr-3">{hop.with ?? o.unknown}</td>
                <td className="py-1 pr-3 whitespace-nowrap tabular-nums">
                  {hop.at === undefined ? o.unknown : time.format(hop.at)}
                </td>
                <td
                  className={`py-1 whitespace-nowrap tabular-nums ${slow(hop)}`}
                >
                  {delayOf(hop)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Headers({
  headers,
  t,
}: {
  readonly headers: readonly RawHeader[];
  readonly t: I18n;
}) {
  const o = t.original;
  const filterId = useId();
  const [filter, setFilter] = useState("");
  const wanted = filter.trim().toLowerCase();
  const shown = wanted
    ? headers.filter((header) =>
        [header.name, header.value, header.raw].some((text) =>
          text.toLowerCase().includes(wanted),
        ),
      )
    : headers;
  return (
    <div>
      <label htmlFor={filterId} className="sr-only">
        {o.filter}
      </label>
      <input
        id={filterId}
        type="search"
        value={filter}
        placeholder={o.filterPlaceholder}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 pointer-coarse:min-h-11"
      />
      <p
        aria-live="polite"
        className="mt-2 mb-1 text-xs text-zinc-500 dark:text-zinc-400"
      >
        {shown.length === 0
          ? o.noMatch
          : o.headerCount(shown.length, headers.length)}
      </p>
      <dl className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {shown.map((header, index) => (
          <div key={index} className="py-1.5">
            <dt className="font-mono text-xs font-semibold text-zinc-600 dark:text-zinc-300">
              {header.name}
            </dt>
            <dd className="font-mono text-xs break-all whitespace-pre-wrap">
              {header.value}
              {header.raw !== header.value && (
                <span className="mt-0.5 block text-zinc-500 dark:text-zinc-400">
                  {o.asSent}: {header.raw}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Source({ text, t }: { readonly text: string; readonly t: I18n }) {
  const o = t.original;
  const segments = useMemo(() => sourceSegments(text), [text]);
  return (
    <pre
      aria-label={o.sourceLabel}
      className="font-mono text-xs break-all whitespace-pre-wrap"
    >
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          segment.text
        ) : (
          <span
            key={index}
            className="my-1 flex items-center gap-2 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 font-sans text-sm break-normal whitespace-normal text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <Icon name="paperclip" className="size-4 shrink-0" />
            {o.collapsed(
              segment.filename ?? segment.mimeType,
              formatBytes(segment.size, t.locale),
            )}
          </span>
        ),
      )}
    </pre>
  );
}
