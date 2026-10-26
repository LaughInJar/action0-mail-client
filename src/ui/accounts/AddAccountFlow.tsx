import { useEffect, useId, useState } from "react";
import {
  useAccountRegistry,
  useAvailableModules,
  useMailServerAccounts,
  useProviderSetup,
} from "../../accounts/context";
import type { AccountHandle } from "../../accounts/types";
import type { ProviderType } from "../../core/model";
import { useFetchMailboxes } from "../../data/hooks";
import { useRouter, useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { Icon } from "../common/Icon";
import {
  ACCOUNT_TYPE_CARDS,
  ENTRA_LINKS,
  GOOGLE_CLOUD_LINKS,
  type AccountTypeCard,
} from "./accountTypes";
import { useT, type I18n } from "../../i18n/context";
import { RichText, type TagRenderer } from "../common/RichText";
import { usePlatform } from "../../platform/context";
import type { Platform } from "../../platform/types";
import { sha1Hex } from "./fingerprint";
import { MailServerFlow } from "./MailServerFlow";
import {
  CopyableValue,
  ErrorNote,
  ExternalLink,
  HelpItem,
  PRIMARY_BUTTON,
  StepFrame,
} from "./wizardParts";

/** Providers that are set up (client ID) and authorized in the wizard. */
type SignInType = Exclude<ProviderType, "demo" | "imap">;

type Step =
  | { readonly kind: "choose" }
  | { readonly kind: "setup"; readonly type: SignInType }
  | { readonly kind: "connect"; readonly type: SignInType }
  /** A mail server (IMAP/SMTP) account: its own steps (`known`: the accounts before). */
  | { readonly kind: "server"; readonly known: ReadonlySet<string> };

/** Where Microsoft's sign-in returns to (the redirect URI to register). */
function microsoftRedirectUri(): string {
  return new URL(
    `${import.meta.env.BASE_URL}redirect.html`,
    window.location.origin,
  ).href;
}

/** What Google's client secrets look like (an example, not text). */
const SECRET_EXAMPLE = "GOCSPX-…";

/** Where Microsoft's sign-in returns to in the desktop app (any port). */
const DESKTOP_REDIRECT_URI = "http://localhost/desktop";

/** A provider's wizard texts, and the links and values its texts refer to. */
/** Texts and live values of a provider's setup, for where the app runs. */
function setupCopy(type: SignInType, t: I18n, platform: Platform) {
  const desktop = platform.kind === "desktop";
  const { mobile } = platform;
  // The Android app's package and signing key, as the providers ask for them.
  const android: Readonly<Record<string, TagRenderer>> = mobile
    ? {
        package: () => <CopyableValue value={mobile.package} />,
        sha1: () => <CopyableValue value={sha1Hex(mobile.signatureHash)} />,
      }
    : {};
  const external = (links: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(links).map(([name, href]): [string, TagRenderer] => [
        name,
        (text) => <ExternalLink href={href}>{text}</ExternalLink>,
      ]),
    );
  if (type === "gmail")
    return {
      texts: mobile
        ? t.accounts.googleAndroid
        : desktop
          ? t.accounts.googleDesktop
          : t.accounts.google,
      tags: {
        ...external(GOOGLE_CLOUD_LINKS),
        ...android,
        origin: () => <CopyableValue value={window.location.origin} />,
      },
      example: "1234567890-abc123.apps.googleusercontent.com",
    };
  return {
    texts: mobile
      ? t.accounts.microsoftAndroid
      : desktop
        ? t.accounts.microsoftDesktop
        : t.accounts.microsoft,
    tags: {
      ...external(ENTRA_LINKS),
      ...(mobile
        ? {
            ...android,
            // Entra asks for the signature hash as base64.
            sha1: () => <CopyableValue value={mobile.signatureHash} />,
          }
        : {}),
      redirect: () => (
        <CopyableValue
          value={
            mobile
              ? mobile.microsoftRedirect
              : desktop
                ? DESKTOP_REDIRECT_URI
                : microsoftRedirectUri()
          }
        />
      ),
    },
    example: "00000000-0000-0000-0000-000000000000",
  };
}

/** Props of {@link AddAccountFlow}. */
export interface AddAccountFlowProps {
  /** Id for the step heading (the dialog is labelled by it). */
  readonly titleId: string;
  /** Called once an account is connected and its Inbox is opening. */
  readonly onConnected?: () => void;
}

/**
 * Adding an account: choose the type, set the provider up if needed (Google's
 * client ID), then authorize. Used in the Add account dialog and inline on
 * the welcome screen.
 */
export function AddAccountFlow({ titleId, onConnected }: AddAccountFlowProps) {
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const registry = useAccountRegistry();
  const store = useUiStore();
  const router = useRouter();
  const fetchMailboxes = useFetchMailboxes();
  const a = useT().accounts;
  const platform = usePlatform();

  /** Says the account is connected and opens its Inbox. */
  const opened =
    (known: ReadonlySet<string>) =>
    async (handle: AccountHandle): Promise<void> => {
      const { id, email } = handle.account;
      store.getState().showToast({
        message: known.has(id)
          ? a.reconnected(email)
          : // Without a keychain the desktop app forgets accounts on quitting.
            platform.desktop?.keychain === false
            ? a.connectedUntilQuit(email)
            : a.connected(email),
        tone: "info",
      });
      onConnected?.();
      const mailboxes = await fetchMailboxes(id).catch(() => []);
      const inbox =
        mailboxes.find((mailbox) => mailbox.role === "inbox") ??
        mailboxes.find((mailbox) => mailbox.selectable);
      if (inbox) router.navigate({ accountId: id, mailboxId: inbox.id });
    };
  const knownIds = () => new Set(registry.list().map((h) => h.account.id));

  /** Connects (must run inside the click), then opens the new Inbox. */
  const connect = (type: ProviderType): Promise<void> =>
    registry.add(type).then(opened(knownIds()));

  switch (step.kind) {
    case "choose":
      return (
        <ChooseStep
          titleId={titleId}
          onChoose={(type, needsSetup) => {
            setStep(
              needsSetup ? { kind: "setup", type } : { kind: "connect", type },
            );
          }}
          onChooseServer={() => {
            setStep({ kind: "server", known: knownIds() });
          }}
          connectDemo={() => connect("demo")}
        />
      );
    case "setup":
      return (
        <SetupStep
          type={step.type}
          titleId={titleId}
          onBack={() => {
            setStep({ kind: "choose" });
          }}
          onSaved={() => {
            setStep({ kind: "connect", type: step.type });
          }}
        />
      );
    case "server":
      return (
        <MailServerFlow
          titleId={titleId}
          onBack={() => {
            setStep({ kind: "choose" });
          }}
          onUseType={(type) => {
            // Like choosing the card: set up first if needed.
            const ready = registry
              .availableModules()
              .some((module) => module.type === type);
            setStep(
              ready ? { kind: "connect", type } : { kind: "setup", type },
            );
          }}
          onAdded={opened(step.known)}
        />
      );
    case "connect":
      return (
        <ConnectStep
          type={step.type}
          titleId={titleId}
          onBack={() => {
            setStep({ kind: "choose" });
          }}
          onChangeClientId={() => {
            setStep({ kind: "setup", type: step.type });
          }}
          connect={() => connect(step.type)}
        />
      );
  }
}

function ChooseStep({
  titleId,
  onChoose,
  onChooseServer,
  connectDemo,
}: {
  titleId: string;
  onChoose: (type: SignInType, needsSetup: boolean) => void;
  onChooseServer: () => void;
  connectDemo: () => Promise<void>;
}) {
  const modules = useAvailableModules();
  const mailServers = useMailServerAccounts();
  const googleSetup = useProviderSetup("gmail");
  const microsoftSetup = useProviderSetup("microsoft");
  const [error, setError] = useState<string>();
  const t = useT();
  const a = t.accounts;

  const statusOf = (card: AccountTypeCard) => {
    if (card.comingLater) return "coming-later" as const;
    // Mail servers need the apps' native side.
    if (card.type === "imap")
      return mailServers ? ("available" as const) : ("apps-only" as const);
    if (modules.some((module) => module.type === card.type))
      return "available" as const;
    if (card.type === "gmail" && googleSetup) return "needs-setup" as const;
    if (card.type === "microsoft" && microsoftSetup)
      return "needs-setup" as const;
    return "unavailable" as const;
  };
  const cards = ACCOUNT_TYPE_CARDS.map((card) => ({
    card,
    status: statusOf(card),
  })).filter(({ status }) => status !== "unavailable");

  return (
    <StepFrame titleId={titleId} title={a.addAccount}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{a.whichKind}</p>
      <ul className="space-y-2">
        {cards.map(({ card, status }) => (
          <li key={card.type}>
            <button
              type="button"
              disabled={status === "coming-later" || status === "apps-only"}
              onClick={() => {
                setError(undefined);
                if (card.type === "demo") {
                  connectDemo().catch((cause: unknown) => {
                    setError(errorMessage(cause, t));
                  });
                } else if (card.type === "imap") {
                  onChooseServer();
                } else {
                  onChoose(card.type, status === "needs-setup");
                }
              }}
              className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:border-blue-400 hover:bg-blue-50/50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-zinc-200 disabled:hover:bg-transparent dark:border-zinc-700 dark:hover:bg-blue-500/10"
            >
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-zinc-100 font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              >
                {card.mark}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {a.types[card.type].title}
                </span>
                <span className="block text-sm text-zinc-500">
                  {a.types[card.type].description}
                </span>
              </span>
              {(status === "coming-later" || status === "apps-only") && (
                <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">
                  {status === "apps-only" ? t.imap.appsOnly : a.comingLater}
                </span>
              )}
              {status === "needs-setup" && (
                <span className="shrink-0 text-xs text-zinc-500">
                  {a.oneTimeSetup}
                </span>
              )}
              {status !== "coming-later" && status !== "apps-only" && (
                <Icon
                  name="chevron-right"
                  className="size-4 shrink-0 text-zinc-400"
                />
              )}
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote message={error} />
    </StepFrame>
  );
}

function SetupStep({
  type,
  titleId,
  onBack,
  onSaved,
}: {
  type: SignInType;
  titleId: string;
  onBack: () => void;
  onSaved: () => void;
}) {
  const setup = useProviderSetup(type);
  const current = setup?.current();
  const [value, setValue] = useState(
    current?.source === "browser" ? current.value : "",
  );
  const [secret, setSecret] = useState(
    current?.source === "browser" ? (current.secret ?? "") : "",
  );
  const [error, setError] = useState<string>();
  const [secretError, setSecretError] = useState<string>();
  const inputId = useId();
  const errorId = useId();
  const secretId = useId();
  const secretErrorId = useId();
  const t = useT();
  const a = t.accounts;
  const { texts, tags, example } = setupCopy(type, t, usePlatform());

  const save = () => {
    if (!setup) return;
    const problem = setup.validate(value);
    setError(problem && texts.problems[problem]);
    const secretProblem = setup.secret?.validate(secret);
    setSecretError(secretProblem && a.secretProblems[secretProblem]);
    if (problem !== undefined || secretProblem !== undefined) return;
    setup.apply(value, setup.secret ? secret : undefined);
    onSaved();
  };

  return (
    <StepFrame titleId={titleId} title={texts.setUp} onBack={onBack}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{texts.intro}</p>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {texts.steps.map((step) => (
          <li key={step}>
            <RichText text={step} tags={tags} />
          </li>
        ))}
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        className="space-y-2"
        noValidate
      >
        <label className="block text-sm font-medium" htmlFor={inputId}>
          {a.clientId}
        </label>
        <input
          id={inputId}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
          placeholder={example}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
        />
        <ErrorNote id={errorId} message={error} />
        {!setup?.secret && (
          <p className="text-xs text-zinc-500">{a.clientIdNote}</p>
        )}
        {setup?.secret && (
          <>
            <label className="block text-sm font-medium" htmlFor={secretId}>
              {a.clientSecret}
            </label>
            <input
              id={secretId}
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
                setSecretError(undefined);
              }}
              placeholder={SECRET_EXAMPLE}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={secretError !== undefined}
              aria-describedby={
                secretError === undefined ? undefined : secretErrorId
              }
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
            <ErrorNote id={secretErrorId} message={secretError} />
            <p className="text-xs text-zinc-500">{a.clientSecretNote}</p>
          </>
        )}
        <button type="submit" className={PRIMARY_BUTTON}>
          {a.saveAndContinue}
        </button>
      </form>
    </StepFrame>
  );
}

function ConnectStep({
  type,
  titleId,
  onBack,
  onChangeClientId,
  connect,
}: {
  type: SignInType;
  titleId: string;
  onBack: () => void;
  onChangeClientId: () => void;
  connect: () => Promise<void>;
}) {
  const module = useAvailableModules().find(
    (candidate) => candidate.type === type,
  );
  const setup = useProviderSetup(type);
  const [prepared, setPrepared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = module?.prepare === undefined || prepared;
  const t = useT();
  const a = t.accounts;
  const { texts, tags } = setupCopy(type, t, usePlatform());

  // Load the sign-in library first, so the popup opens inside the click.
  useEffect(() => {
    if (!module?.prepare) return;
    let active = true;
    module.prepare().then(
      () => {
        if (active) setPrepared(true);
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause, t));
      },
    );
    return () => {
      active = false;
    };
  }, [module, t]);

  const start = () => {
    setBusy(true);
    setError(undefined);
    connect()
      .catch((cause: unknown) => {
        setError(errorMessage(cause, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  let label = error === undefined ? texts.continueWith : t.common.tryAgain;
  if (!ready) label = texts.loading;
  else if (busy) label = texts.waiting;

  return (
    <StepFrame titleId={titleId} title={texts.connect} onBack={onBack}>
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
        {texts.notes.map((note) => (
          <li key={note}>
            <RichText text={note} />
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={!ready || busy}
        onClick={start}
        className={PRIMARY_BUTTON}
      >
        {label}
      </button>
      <ErrorNote message={error} />
      <details className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
        <summary className="cursor-default font-medium">
          {texts.errorQuestion}
        </summary>
        <dl className="mt-2 space-y-2">
          {texts.help.map(({ term, text }) => (
            <HelpItem key={term} term={term}>
              <RichText text={text} tags={tags} />
            </HelpItem>
          ))}
        </dl>
      </details>
      {setup?.current()?.source === "browser" && (
        <button
          type="button"
          onClick={onChangeClientId}
          className="text-sm text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
        >
          {a.otherClientId}
        </button>
      )}
    </StepFrame>
  );
}
