import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type SubmitEvent } from "react";
import { useMailServerAccounts } from "../../accounts/context";
import type {
  CalendarServerCandidate,
  CalendarServerLogin,
} from "../../accounts/calendarServer";
import {
  isMailServerError,
  type MailServerCertificate,
  type MailServerError,
} from "../../accounts/mailServer";
import type { CalendarSource } from "../../data/calendar";
import { useCalendarServers } from "../../data/calendarServers";
import { queryKeys } from "../../data/keys";
import { useT, type I18n } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import { CertificateStep, ExternalLink } from "../accounts/wizardParts";
import { errorMessage } from "../common/errorMessage";
import { Sheet } from "../common/Sheet";

const FIELD =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 pointer-coarse:min-h-11";
const LINK_BUTTON =
  "rounded-md px-2 py-1 text-sm text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-500/15 pointer-coarse:min-h-11";

/**
 * Sets up a calendar server (CalDAV): a mail account's (found from its
 * address, with the mail login or another), or a calendar-only one; also
 * changes a connected one. Connecting checks the login and finds the
 * calendars; a certificate the system doesn't trust can be trusted once.
 */
export function CalendarServerDialog({
  source,
  onClose,
}: {
  /** A mail account's calendars, or a calendar-only server to change; absent to add one. */
  source?: CalendarSource;
  onClose: () => void;
}) {
  const t = useT();
  const s = t.calendar.server;
  const sources = useCalendarServers();
  const mailServers = useMailServerAccounts();
  const store = useUiStore();
  const queryClient = useQueryClient();
  const titleId = useId();
  const urlId = useId();
  const nameId = useId();
  const userId = useId();
  const passwordId = useId();
  const existing = source?.server;
  const forAccount = source?.kind === "account";
  const [candidates, setCandidates] = useState<
    readonly CalendarServerCandidate[] | undefined
  >(forAccount && !existing ? undefined : []);
  const [url, setUrl] = useState(existing?.home ?? "");
  const [urlTouched, setUrlTouched] = useState(existing !== undefined);
  const [name, setName] = useState(existing?.label ?? "");
  const [sameLogin, setSameLogin] = useState(
    forAccount && (existing?.sameAsMail ?? true),
  );
  const [username, setUsername] = useState(existing?.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [certificate, setCertificate] = useState<MailServerCertificate>();

  // A mail account's server is looked for right away.
  const address = forAccount ? source.label : undefined;
  const accountId = source?.accountId;
  useEffect(() => {
    if (!sources || !address || existing) return;
    const run = { cancelled: false };
    void (async () => {
      const info = accountId ? await mailServers?.info(accountId) : undefined;
      const found = await sources.servers
        .discover(address, info?.settings.imap.host)
        .catch(() => [] as const);
      if (run.cancelled) return;
      setCandidates(found);
      setUrl((current) => current || (found[0]?.url ?? ""));
    })();
    return () => {
      run.cancelled = true;
    };
  }, [sources, address, accountId, existing, mailServers]);

  if (!sources) return null;
  const known = candidates?.find((candidate) => candidate.providerName);
  const appPasswordUrl = candidates?.find(
    (candidate) => candidate.appPasswordUrl,
  )?.appPasswordUrl;
  const label = forAccount ? source.label : name.trim() || hostOf(url);

  const connect = async (trust?: string) => {
    setBusy(true);
    setError(undefined);
    const login: CalendarServerLogin = sameLogin
      ? { sameAsMail: true }
      : { username: username.trim(), password };
    const urls =
      urlTouched || !candidates?.length
        ? [withScheme(url)]
        : candidates.map((candidate) => candidate.url);
    try {
      const info = await sources.servers.connect({
        ...(forAccount && accountId ? { key: accountId } : {}),
        ...(source?.kind === "caldav" ? { key: source.key } : {}),
        ...(forAccount ? {} : { label }),
        urls,
        login,
        ...(trust ? { trust } : {}),
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.calendars(info.key),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.calendarEvents(info.key),
        }),
      ]);
      store
        .getState()
        .showToast({ message: s.connected(info.label), tone: "info" });
      onClose();
    } catch (cause) {
      if (
        isMailServerError(cause) &&
        cause.kind === "untrusted" &&
        cause.certificate
      )
        setCertificate(cause.certificate);
      else setError(errorText(cause, t, hostOf(urls[0] ?? "")));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy) void connect();
  };

  const confirmRemove = () => {
    if (!existing) return;
    onClose();
    store.getState().setConfirm({
      title: forAccount
        ? s.disconnectTitle(existing.label)
        : s.removeTitle(existing.label),
      message: s.removeMessage,
      confirmLabel: forAccount ? s.disconnect : t.calendar.remove,
      action: {
        kind: "remove-calendar-server",
        key: existing.key,
        name: existing.label,
      },
    });
  };

  const forgetCertificate = () => {
    if (!existing) return;
    sources.servers.forgetCertificate(existing.key).then(
      () => {
        store
          .getState()
          .showToast({ message: s.certificateForgotten, tone: "info" });
        onClose();
      },
      (cause: unknown) => {
        setError(errorMessage(cause, t));
      },
    );
  };

  const title = forAccount
    ? s.titleAccount(source.label)
    : existing
      ? s.titleEdit(existing.label)
      : s.titleNew;

  return (
    <Sheet labelledBy={titleId} onEscape={onClose}>
      {certificate ? (
        <div className="overflow-y-auto p-4">
          <CertificateStep
            titleId={titleId}
            certificate={certificate}
            busy={busy}
            onTrust={() => {
              void connect(certificate.sha256).then(() => {
                setCertificate(undefined);
              });
            }}
            onCancel={() => {
              setCertificate(undefined);
            }}
            error={error}
          />
        </div>
      ) : (
        <form onSubmit={submit} className="flex min-h-0 flex-col" noValidate>
          <div className="space-y-4 overflow-y-auto p-4">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {candidates === undefined ? (
              <p className="text-sm text-zinc-500" role="status">
                {s.looking}
              </p>
            ) : (
              forAccount &&
              !existing && (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {candidates.length === 0
                    ? s.notFound
                    : s.found(known?.providerName ?? hostOf(url))}
                </p>
              )
            )}
            {!forAccount && (
              <div className="space-y-1">
                <label htmlFor={nameId} className="text-sm font-medium">
                  {s.name}
                </label>
                <input
                  id={nameId}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  autoComplete="off"
                  className={FIELD}
                />
              </div>
            )}
            <div className="space-y-1">
              <label htmlFor={urlId} className="text-sm font-medium">
                {s.url}
              </label>
              <input
                id={urlId}
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setUrlTouched(true);
                  setError(undefined);
                }}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                {...(forAccount ? {} : { "data-initial-focus": "" })}
                className={`${FIELD} font-mono`}
              />
              <p className="text-xs text-zinc-500">{s.urlHint}</p>
            </div>
            {forAccount && (
              <fieldset className="space-y-1">
                <legend className="sr-only">{s.username}</legend>
                {[true, false].map((same) => (
                  <label
                    key={String(same)}
                    className="flex cursor-pointer items-center gap-2.5 text-sm pointer-coarse:min-h-11"
                  >
                    <input
                      type="radio"
                      name="calendar-login"
                      checked={sameLogin === same}
                      onChange={() => {
                        setSameLogin(same);
                      }}
                      className="size-4 accent-blue-600"
                    />
                    {same ? s.sameLogin : s.otherLogin}
                  </label>
                ))}
              </fieldset>
            )}
            {!sameLogin && (
              <>
                <div className="space-y-1">
                  <label htmlFor={userId} className="text-sm font-medium">
                    {s.username}
                  </label>
                  <input
                    id={userId}
                    value={username}
                    onChange={(event) => {
                      setUsername(event.target.value);
                    }}
                    autoComplete="username"
                    spellCheck={false}
                    className={FIELD}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={passwordId} className="text-sm font-medium">
                    {s.password}
                  </label>
                  <input
                    id={passwordId}
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                    }}
                    autoComplete="current-password"
                    className={FIELD}
                  />
                  {existing && !existing.sameAsMail && !password && (
                    <p className="text-xs text-zinc-500">{s.passwordAgain}</p>
                  )}
                  {appPasswordUrl && (
                    <p className="text-xs">
                      <ExternalLink href={appPasswordUrl}>
                        {s.appPassword}
                      </ExternalLink>
                    </p>
                  )}
                </div>
              </>
            )}
            {error && (
              <p
                role="alert"
                className="text-sm text-red-700 dark:text-red-400"
              >
                {error}
              </p>
            )}
            {existing && (
              <div className="flex flex-wrap gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={confirmRemove}
                  className={LINK_BUTTON}
                >
                  {forAccount ? s.disconnect : t.calendar.remove}
                </button>
                {existing.pinned && (
                  <button
                    type="button"
                    onClick={forgetCertificate}
                    className={LINK_BUTTON}
                  >
                    {s.forgetCertificate}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
            >
              {t.common.cancel}
            </button>
            <button
              type="submit"
              disabled={
                busy ||
                candidates === undefined ||
                !url.trim() ||
                (!sameLogin && (!username.trim() || !password))
              }
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 pointer-coarse:min-h-11"
            >
              {busy ? s.connecting : s.connect}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

/** A typed address with `https://` if it has no scheme. */
function withScheme(url: string): string {
  const trimmed = url.trim();
  return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function hostOf(url: string): string {
  try {
    return new URL(withScheme(url)).host;
  } catch {
    return url;
  }
}

/** What went wrong while connecting, in words. */
function errorText(cause: unknown, t: I18n, host: string): string {
  const e = t.calendar.server.errors;
  if (!isMailServerError(cause)) return errorMessage(cause, t);
  const failure: MailServerError = cause;
  switch (failure.kind) {
    case "auth":
    case "oauth":
      return e.auth;
    case "notFound":
      return e.notFound;
    case "unreachable":
      return e.unreachable(host);
    case "tls":
    case "untrusted":
      return e.tls(host);
    case "exists":
    case "rejected":
    case "server":
    case "tooBig":
      return e.server(failure.message);
  }
}
