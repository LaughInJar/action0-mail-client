import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMailServerAccounts } from "../../accounts/context";
import {
  isMailServerError,
  type MailServer,
  type MailServerCertificate,
  type MailServerDiscovery,
  type MailServerError,
  type MailServerOAuth,
  type MailServerSecurity,
  type MailServerSettings,
} from "../../accounts/mailServer";
import type { AccountHandle } from "../../accounts/types";
import { useCalendarServers } from "../../data/calendarServers";
import { useT, type I18n } from "../../i18n/context";
import {
  CertificateStep,
  ErrorNote,
  ExternalLink,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  StepFrame,
} from "./wizardParts";

/** Yahoo's and AOL's names, for buttons and texts. */
const OAUTH_NAMES: Readonly<Record<MailServerOAuth, string>> = {
  yahoo: "Yahoo",
  aol: "AOL",
};

const FIELD =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 pointer-coarse:min-h-11";

/** Props of {@link MailServerFlow}. */
export interface MailServerFlowProps {
  readonly titleId: string;
  readonly onBack: () => void;
  /** A Google or Microsoft address: go to that account type instead. */
  readonly onUseType: (type: "gmail" | "microsoft") => void;
  /** The account was added: say so and open its Inbox. */
  readonly onAdded: (handle: AccountHandle) => Promise<void>;
}

/** Settings to start from when nothing was found: the usual host names. */
function guessed(address: string): MailServerSettings {
  const domain = address.split("@").at(-1) ?? "";
  return {
    imap: { host: `imap.${domain}`, port: 993, security: "tls" },
    smtp: { host: `smtp.${domain}`, port: 465, security: "tls" },
    username: address,
  };
}

/**
 * Adding an IMAP/SMTP account: the address (its settings are looked up),
 * then the settings to check and the password or Yahoo/AOL sign-in, and a
 * certificate the system doesn't trust, if the server has one.
 */
export function MailServerFlow({
  titleId,
  onBack,
  onUseType,
  onAdded,
}: MailServerFlowProps) {
  const t = useT();
  const m = t.imap;
  const servers = useMailServerAccounts();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [discovery, setDiscovery] = useState<MailServerDiscovery>();
  const [settings, setSettings] = useState<MailServerSettings>();
  const [busy, setBusy] = useState<"lookup" | "connect">();
  const [error, setError] = useState<string>();
  const addressId = useId();
  const nameId = useId();
  const calendarServers = useCalendarServers();
  const [added, setAdded] = useState<AccountHandle>();

  if (!servers) return null;
  if (added)
    return (
      <CalendarStep
        titleId={titleId}
        handle={added}
        onDone={() => onAdded(added)}
      />
    );

  const lookUp = async () => {
    const trimmed = address.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError(m.invalidAddress);
      return;
    }
    setError(undefined);
    setBusy("lookup");
    const found = await servers
      .discover(trimmed)
      .catch((): MailServerDiscovery => ({ source: "none" }));
    setBusy(undefined);
    setDiscovery(found);
    if (!found.better) setSettings(found.settings ?? guessed(trimmed));
  };

  if (settings && discovery)
    return (
      <SettingsStep
        titleId={titleId}
        address={address.trim()}
        name={name.trim()}
        discovery={discovery}
        initial={settings}
        onBack={() => {
          setSettings(undefined);
          setDiscovery(undefined);
        }}
        onAdded={async (handle) => {
          // Its calendars next, where the app has calendar servers.
          if (calendarServers) setAdded(handle);
          else await onAdded(handle);
        }}
      />
    );

  return (
    <StepFrame titleId={titleId} title={m.title} onBack={onBack}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.intro}</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void lookUp();
        }}
      >
        <Field id={addressId} label={m.address}>
          <input
            id={addressId}
            type="email"
            autoComplete="email"
            required
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setDiscovery(undefined);
            }}
            className={FIELD}
          />
        </Field>
        <Field id={nameId} label={m.name} hint={m.nameHint}>
          <input
            id={nameId}
            autoComplete="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={FIELD}
          />
        </Field>
        {discovery?.better ? (
          <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-500/10 dark:text-amber-100">
            <p>
              {discovery.better === "gmail" ? m.betterGmail : m.betterMicrosoft}
            </p>
            <button
              type="button"
              onClick={() => {
                if (discovery.better) onUseType(discovery.better);
              }}
              className={PRIMARY_BUTTON}
            >
              {discovery.better === "gmail" ? m.addAsGmail : m.addAsMicrosoft}
            </button>
            {discovery.better === "gmail" && (
              <button
                type="button"
                onClick={() => {
                  setSettings(discovery.settings ?? guessed(address.trim()));
                }}
                className={SECONDARY_BUTTON}
              >
                {m.useImapAnyway}
              </button>
            )}
          </div>
        ) : (
          <button
            type="submit"
            disabled={busy !== undefined}
            className={PRIMARY_BUTTON}
          >
            {busy === "lookup" ? m.lookingUp : m.next}
          </button>
        )}
        <ErrorNote message={error} />
      </form>
    </StepFrame>
  );
}

/**
 * After the mail: the account's calendar server is looked for (with the
 * mail login), and if one answers, the user decides whether its calendars
 * show. Nothing found, or a server that wants more: done (they can be set
 * up later in the calendar).
 */
function CalendarStep({
  titleId,
  handle,
  onDone,
}: {
  readonly titleId: string;
  readonly handle: AccountHandle;
  readonly onDone: () => Promise<void>;
}) {
  const t = useT();
  const c = t.calendar.calendarStep;
  const sources = useCalendarServers();
  const mailServers = useMailServerAccounts();
  const [found, setFound] = useState<{
    readonly host: string;
    readonly contacts: boolean;
  }>();
  const done = useRef(false);
  const finish = useRef(onDone);
  useEffect(() => {
    finish.current = onDone;
  });
  const key = handle.account.id;

  useEffect(() => {
    if (!sources) return;
    const run = { skipped: false };
    void (async () => {
      try {
        const info = await mailServers?.info(key);
        const candidates = await sources.servers.discover(
          handle.account.email,
          info?.settings.imap.host,
        );
        if (candidates.length === 0) throw new Error("none");
        const server = await sources.servers.connect({
          key,
          urls: candidates.map((candidate) => candidate.url),
          login: { sameAsMail: true },
        });
        // Skipped meanwhile: not wanted.
        if (run.skipped || done.current) {
          await sources.servers.remove(key);
          return;
        }
        setFound({
          host: new URL(server.home).host,
          contacts: server.contacts !== undefined,
        });
      } catch {
        if (!run.skipped && !done.current) {
          done.current = true;
          await finish.current();
        }
      }
    })();
    return () => {
      run.skipped = true;
    };
  }, [sources, mailServers, key, handle.account.email]);

  const end = async (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    if (!keep) await sources?.servers.remove(key).catch(() => undefined);
    await finish.current();
  };

  return (
    <StepFrame titleId={titleId} title={handle.account.email}>
      {found === undefined ? (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400" role="status">
            {c.looking}
          </p>
          <button
            type="button"
            onClick={() => {
              void end(false);
            }}
            className={SECONDARY_BUTTON}
          >
            {c.notNow}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm">
            {found.contacts
              ? c.foundWithContacts(found.host)
              : c.found(found.host)}
          </p>
          <button
            type="button"
            onClick={() => {
              void end(true);
            }}
            className={PRIMARY_BUTTON}
          >
            {c.show}
          </button>
          <button
            type="button"
            onClick={() => {
              void end(false);
            }}
            className={SECONDARY_BUTTON}
          >
            {c.notNow}
          </button>
        </>
      )}
    </StepFrame>
  );
}

/** The settings to check, the password or sign-in, and connecting. */
function SettingsStep({
  titleId,
  address,
  name,
  discovery,
  initial,
  onBack,
  onAdded,
}: {
  readonly titleId: string;
  readonly address: string;
  readonly name: string;
  readonly discovery: MailServerDiscovery;
  readonly initial: MailServerSettings;
  readonly onBack: () => void;
  readonly onAdded: (handle: AccountHandle) => Promise<void>;
}) {
  const t = useT();
  const m = t.imap;
  const servers = useMailServerAccounts();
  const [settings, setSettings] = useState(initial);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"connect" | "signIn">();
  const [error, setError] = useState<string>();
  const [certificate, setCertificate] = useState<MailServerCertificate>();
  const passwordId = useId();
  const usernameId = useId();
  const oauth = discovery.oauth;
  const [client, setClient] = useState(() =>
    oauth ? servers?.oauthClient(oauth)?.client : undefined,
  );
  if (!servers) return null;

  const connect = async (
    credentials: Parameters<typeof servers.add>[0]["credentials"],
    trust?: string,
  ) => {
    setBusy("password" in credentials ? "connect" : "signIn");
    setError(undefined);
    try {
      const handle = await servers.add({
        address,
        name: name || address,
        settings,
        credentials,
        ...(trust ? { trust } : {}),
      });
      setCertificate(undefined);
      await onAdded(handle);
    } catch (cause) {
      if (
        isMailServerError(cause) &&
        cause.kind === "untrusted" &&
        cause.certificate
      ) {
        setCertificate(cause.certificate);
      } else {
        setError(
          errorText(cause, settings, discovery, t, oauth && OAUTH_NAMES[oauth]),
        );
      }
    } finally {
      setBusy(undefined);
    }
  };

  const server = (which: "imap" | "smtp", value: MailServer) => {
    setSettings((current) => ({ ...current, [which]: value }));
  };

  if (certificate)
    return (
      <CertificateStep
        titleId={titleId}
        certificate={certificate}
        busy={busy !== undefined}
        onTrust={() => {
          void connect(
            oauth && client && !password ? { oauth, client } : { password },
            certificate.sha256,
          );
        }}
        onCancel={() => {
          setCertificate(undefined);
        }}
        error={error}
      />
    );

  return (
    <StepFrame titleId={titleId} title={address} onBack={onBack}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {discovery.providerName ? `${m.foundFor(discovery.providerName)} ` : ""}
        {m.found[discovery.source]}
      </p>
      <details
        open={discovery.source === "none"}
        className="rounded-lg border border-zinc-200 dark:border-zinc-700"
      >
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium pointer-coarse:min-h-11">
          {m.serverSettings}
        </summary>
        <div className="space-y-4 px-3 pb-3">
          <ServerFields
            legend={m.incoming}
            value={settings.imap}
            onChange={(value) => {
              server("imap", value);
            }}
          />
          <ServerFields
            legend={m.outgoing}
            value={settings.smtp}
            onChange={(value) => {
              server("smtp", value);
            }}
          />
          <Field id={usernameId} label={m.username}>
            <input
              id={usernameId}
              autoComplete="username"
              value={settings.username}
              onChange={(event) => {
                setSettings((current) => ({
                  ...current,
                  username: event.target.value,
                }));
              }}
              className={FIELD}
            />
          </Field>
        </div>
      </details>

      {oauth && (
        <OAuthSignIn
          provider={oauth}
          client={client}
          busy={busy === "signIn"}
          onClient={(next) => {
            servers.setOAuthClient(oauth, next);
            setClient(next);
          }}
          onSignIn={() => {
            if (client) void connect({ oauth, client });
          }}
        />
      )}

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void connect({ password });
        }}
      >
        {oauth && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {m.orPassword}
          </p>
        )}
        <Field id={passwordId} label={m.password}>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            className={FIELD}
          />
        </Field>
        {discovery.appPasswordUrl && (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {m.appPasswordHint}{" "}
            <ExternalLink href={discovery.appPasswordUrl}>
              {m.makeAppPassword}
            </ExternalLink>
          </p>
        )}
        {discovery.enableImapUrl && (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {m.enableImap}{" "}
            <ExternalLink href={discovery.enableImapUrl}>
              {m.enableImapLink}
            </ExternalLink>
          </p>
        )}
        <button
          type="submit"
          disabled={busy !== undefined || password === ""}
          className={PRIMARY_BUTTON}
        >
          {busy === "connect" ? m.connecting : m.connect}
        </button>
        <ErrorNote message={error} />
      </form>
    </StepFrame>
  );
}

/** A server's host, port and encryption. */
function ServerFields({
  legend,
  value,
  onChange,
}: {
  readonly legend: string;
  readonly value: MailServer;
  readonly onChange: (value: MailServer) => void;
}) {
  const m = useT().imap;
  const hostId = useId();
  const portId = useId();
  const securityId = useId();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <Field id={hostId} label={m.host}>
        <input
          id={hostId}
          autoCapitalize="off"
          spellCheck={false}
          value={value.host}
          onChange={(event) => {
            onChange({ ...value, host: event.target.value.trim() });
          }}
          className={FIELD}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field id={portId} label={m.port}>
          <input
            id={portId}
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={value.port}
            onChange={(event) => {
              onChange({ ...value, port: Number(event.target.value) });
            }}
            className={FIELD}
          />
        </Field>
        <Field id={securityId} label={m.security}>
          <select
            id={securityId}
            value={value.security}
            onChange={(event) => {
              onChange({
                ...value,
                security: event.target.value as MailServerSecurity,
              });
            }}
            className={FIELD}
          >
            {(["tls", "starttls"] as const).map((security) => (
              <option key={security} value={security}>
                {m.securities[security]}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </fieldset>
  );
}

/** "Sign in with Yahoo", or setting up its app registration first. */
function OAuthSignIn({
  provider,
  client,
  busy,
  onClient,
  onSignIn,
}: {
  readonly provider: MailServerOAuth;
  readonly client:
    { readonly id: string; readonly secret?: string } | undefined;
  readonly busy: boolean;
  readonly onClient: (client: { id: string; secret?: string }) => void;
  readonly onSignIn: () => void;
}) {
  const m = useT().imap;
  const label = OAUTH_NAMES[provider];
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState(client?.id ?? "");
  const [secret, setSecret] = useState(client?.secret ?? "");
  const idId = useId();
  const secretId = useId();

  if (client && !editing)
    return (
      <div className="space-y-2">
        <button
          type="button"
          disabled={busy}
          onClick={onSignIn}
          className={PRIMARY_BUTTON}
        >
          {busy ? m.signingIn : m.signInWith(label)}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(true);
          }}
          className="text-xs text-blue-700 underline dark:text-blue-300"
        >
          {m.oauthSetup.change}
        </button>
      </div>
    );

  return (
    <details
      open={editing}
      className="rounded-lg border border-zinc-200 text-sm dark:border-zinc-700"
    >
      <summary className="cursor-pointer px-3 py-2 font-medium pointer-coarse:min-h-11">
        {m.oauthSetup.title(label)}
      </summary>
      <form
        className="space-y-3 px-3 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!id.trim()) return;
          onClient({
            id: id.trim(),
            ...(secret.trim() ? { secret: secret.trim() } : {}),
          });
          setEditing(false);
        }}
      >
        <p className="text-zinc-600 dark:text-zinc-400">
          {m.oauthSetup.text(label)}
        </p>
        <Field id={idId} label={m.oauthSetup.clientId}>
          <input
            id={idId}
            spellCheck={false}
            value={id}
            onChange={(event) => {
              setId(event.target.value);
            }}
            className={FIELD}
          />
        </Field>
        <Field id={secretId} label={m.oauthSetup.clientSecret}>
          <input
            id={secretId}
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(event) => {
              setSecret(event.target.value);
            }}
            className={FIELD}
          />
        </Field>
        <button
          type="submit"
          disabled={!id.trim()}
          className={SECONDARY_BUTTON}
        >
          {m.oauthSetup.save}
        </button>
      </form>
    </details>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      )}
    </div>
  );
}

/** What went wrong while adding the account, in words. */
function errorText(
  cause: unknown,
  settings: MailServerSettings,
  discovery: MailServerDiscovery,
  t: I18n,
  oauthName: string | undefined,
): string {
  const e = t.imap.errors;
  if (!isMailServerError(cause))
    return cause instanceof Error ? cause.message : String(cause);
  const failure: MailServerError = cause;
  const host =
    failure.server === "smtp" ? settings.smtp.host : settings.imap.host;
  const text = (() => {
    switch (failure.kind) {
      case "auth":
        return discovery.appPasswordUrl ? e.authAppPassword : e.auth;
      case "unreachable":
        return e.unreachable(host);
      case "tls":
      case "untrusted":
        return e.tls(host);
      case "oauth":
        return e.oauth(oauthName ?? "", failure.message);
      case "notFound":
      case "exists":
      case "tooBig":
      case "rejected":
      case "server":
        return e.server(failure.message);
    }
  })();
  return failure.server === "smtp" && failure.kind !== "unreachable"
    ? e.smtp(text)
    : text;
}
