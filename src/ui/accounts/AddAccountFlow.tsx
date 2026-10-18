import { useEffect, useId, useState, type ReactNode } from "react";
import {
  useAccountRegistry,
  useAvailableModules,
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
  GOOGLE_CLOUD_LINKS,
  type AccountTypeCard,
} from "./accountTypes";

type Step =
  | { readonly kind: "choose" }
  | { readonly kind: "setup"; readonly type: ProviderType }
  | { readonly kind: "connect"; readonly type: ProviderType };

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

  /** Connects (must run inside the click), then opens the new Inbox. */
  const connect = (type: ProviderType): Promise<void> => {
    const known = new Set(registry.list().map((h) => h.account.id));
    return registry.add(type).then(async (handle: AccountHandle) => {
      const { id, email } = handle.account;
      store.getState().showToast({
        message: `${known.has(id) ? "Reconnected" : "Connected"} ${email}`,
        tone: "info",
      });
      onConnected?.();
      const mailboxes = await fetchMailboxes(id).catch(() => []);
      const inbox =
        mailboxes.find((mailbox) => mailbox.role === "inbox") ??
        mailboxes.find((mailbox) => mailbox.selectable);
      if (inbox) router.navigate({ accountId: id, mailboxId: inbox.id });
    });
  };

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
          connectDemo={() => connect("demo")}
        />
      );
    case "setup":
      return (
        <GoogleSetupStep
          titleId={titleId}
          onBack={() => {
            setStep({ kind: "choose" });
          }}
          onSaved={() => {
            setStep({ kind: "connect", type: step.type });
          }}
        />
      );
    case "connect":
      return (
        <GoogleConnectStep
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
  connectDemo,
}: {
  titleId: string;
  onChoose: (type: ProviderType, needsSetup: boolean) => void;
  connectDemo: () => Promise<void>;
}) {
  const modules = useAvailableModules();
  const googleSetup = useProviderSetup("gmail");
  const [error, setError] = useState<string>();

  const statusOf = (card: AccountTypeCard) => {
    if (card.comingLater) return "coming-later" as const;
    if (modules.some((module) => module.type === card.type))
      return "available" as const;
    if (card.type === "gmail" && googleSetup) return "needs-setup" as const;
    return "unavailable" as const;
  };
  const cards = ACCOUNT_TYPE_CARDS.map((card) => ({
    card,
    status: statusOf(card),
  })).filter(({ status }) => status !== "unavailable");

  return (
    <StepFrame titleId={titleId} title="Add account">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Which kind of account?
      </p>
      <ul className="space-y-2">
        {cards.map(({ card, status }) => (
          <li key={card.type}>
            <button
              type="button"
              disabled={status === "coming-later"}
              onClick={() => {
                setError(undefined);
                if (card.type === "demo") {
                  connectDemo().catch((cause: unknown) => {
                    setError(errorMessage(cause));
                  });
                } else if (card.type !== "microsoft" && card.type !== "imap") {
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
                <span className="block font-medium">{card.title}</span>
                <span className="block text-sm text-zinc-500">
                  {card.description}
                </span>
              </span>
              {status === "coming-later" && (
                <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">
                  Coming later
                </span>
              )}
              {status === "needs-setup" && (
                <span className="shrink-0 text-xs text-zinc-500">
                  One-time setup
                </span>
              )}
              {status !== "coming-later" && (
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

function GoogleSetupStep({
  titleId,
  onBack,
  onSaved,
}: {
  titleId: string;
  onBack: () => void;
  onSaved: () => void;
}) {
  const setup = useProviderSetup("gmail");
  const current = setup?.current();
  const [value, setValue] = useState(
    current?.source === "browser" ? current.value : "",
  );
  const [error, setError] = useState<string>();
  const inputId = useId();
  const errorId = useId();

  const save = () => {
    if (!setup) return;
    const problem = setup.validate(value);
    setError(problem);
    if (problem !== undefined) return;
    setup.apply(value);
    onSaved();
  };

  return (
    <StepFrame titleId={titleId} title="Set up Google" onBack={onBack}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Google only lets registered apps read mail. Register this app once in
        your own Google Cloud project. It's free and takes about ten minutes;
        the README has the details.
      </p>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          Create a project and{" "}
          <ExternalLink href={GOOGLE_CLOUD_LINKS.gmailApi}>
            enable the Gmail API
          </ExternalLink>
          .
        </li>
        <li>
          In the{" "}
          <ExternalLink href={GOOGLE_CLOUD_LINKS.authPlatform}>
            Google Auth Platform
          </ExternalLink>
          , enter an app name and your email. Under{" "}
          <ExternalLink href={GOOGLE_CLOUD_LINKS.audience}>
            Audience
          </ExternalLink>
          , choose <em>External</em> and add every address you want to connect
          as a <em>test user</em>.
        </li>
        <li>
          Under{" "}
          <ExternalLink href={GOOGLE_CLOUD_LINKS.dataAccess}>
            Data access
          </ExternalLink>
          , add the scope{" "}
          <code className="text-xs">https://mail.google.com/</code>.
        </li>
        <li>
          Under{" "}
          <ExternalLink href={GOOGLE_CLOUD_LINKS.clients}>Clients</ExternalLink>
          , create a client of type <em>Web application</em>. Add this exact
          address under <em>Authorized JavaScript origins</em> and leave
          redirect URIs empty:
          <CopyableOrigin />
        </li>
        <li>Copy the client ID and paste it here.</li>
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
          Client ID
        </label>
        <input
          id={inputId}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
          placeholder="1234567890-abc123.apps.googleusercontent.com"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
        />
        <ErrorNote id={errorId} message={error} />
        <p className="text-xs text-zinc-500">
          Saved as a setting in this browser. The client ID isn't secret.
        </p>
        <button type="submit" className={PRIMARY_BUTTON}>
          Save and continue
        </button>
      </form>
    </StepFrame>
  );
}

function GoogleConnectStep({
  titleId,
  onBack,
  onChangeClientId,
  connect,
}: {
  titleId: string;
  onBack: () => void;
  onChangeClientId: () => void;
  connect: () => Promise<void>;
}) {
  const module = useAvailableModules().find(
    (candidate) => candidate.type === "gmail",
  );
  const setup = useProviderSetup("gmail");
  const [prepared, setPrepared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = module?.prepare === undefined || prepared;

  // Load Google's sign-in script first, so the popup opens inside the click.
  useEffect(() => {
    if (!module?.prepare) return;
    let active = true;
    module.prepare().then(
      () => {
        if (active) setPrepared(true);
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [module]);

  const start = () => {
    setBusy(true);
    setError(undefined);
    connect()
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  let label = error === undefined ? "Continue with Google" : "Try again";
  if (!ready) label = "Loading Google sign-in…";
  else if (busy) label = "Waiting for Google…";

  return (
    <StepFrame titleId={titleId} title="Connect Google" onBack={onBack}>
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
        <li>A Google window opens. Choose your account and allow access.</li>
        <li>
          The app asks for full access to your mailbox, because “Delete forever”
          needs it. There's no server: your mail goes straight from Google to
          this browser.
        </li>
        <li>
          While your Google Cloud app is in <em>Testing</em>, Google warns that
          it isn't verified. Choose <em>Advanced</em> → <em>Go to …</em> to
          continue.
        </li>
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
          Did Google show an error?
        </summary>
        <dl className="mt-2 space-y-2">
          <HelpItem term="“invalid_client” or “no registered origin”">
            The client in Google Cloud is missing this app's address under{" "}
            <em>Authorized JavaScript origins</em>, or it isn't of type{" "}
            <em>Web application</em>. Add exactly:
            <CopyableOrigin />
            Changes can take a few minutes to take effect.
          </HelpItem>
          <HelpItem term="“Access blocked: … has not completed the Google verification process”">
            Your address isn't a test user. Add it under{" "}
            <ExternalLink href={GOOGLE_CLOUD_LINKS.audience}>
              Audience → Test users
            </ExternalLink>
            .
          </HelpItem>
          <HelpItem term="A message about your organization or admin">
            Your Google Workspace administrator blocks unverified apps. Only
            they can allow this app.
          </HelpItem>
        </dl>
      </details>
      {setup?.current()?.source === "browser" && (
        <button
          type="button"
          onClick={onChangeClientId}
          className="text-sm text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
        >
          Use a different client ID
        </button>
      )}
    </StepFrame>
  );
}

const PRIMARY_BUTTON =
  "w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 pointer-coarse:min-h-11";

function StepFrame({
  titleId,
  title,
  onBack,
  children,
}: {
  titleId: string;
  title: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {onBack && (
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            className="grid size-8 place-items-center rounded-md text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:size-11"
          >
            <Icon name="arrow-left" className="size-4" />
          </button>
        )}
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

function ErrorNote({
  message,
  id,
}: {
  message: string | undefined;
  id?: string;
}) {
  if (message === undefined) return null;
  return (
    <p id={id} role="alert" className="text-sm text-red-700 dark:text-red-400">
      {message}
    </p>
  );
}

function HelpItem({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-medium">{term}</dt>
      <dd className="text-zinc-600 dark:text-zinc-400">{children}</dd>
    </div>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-700 underline underline-offset-2 dark:text-blue-300"
    >
      {children}
    </a>
  );
}

/** This app's origin (what Google must know), with a copy button. */
function CopyableOrigin() {
  const origin = window.location.origin;
  const [copied, setCopied] = useState(false);
  const canCopy = "clipboard" in navigator;
  return (
    <span className="my-1.5 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
        {origin}
      </code>
      {canCopy && (
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(origin).then(
              () => {
                setCopied(true);
              },
              () => {
                setCopied(false);
              },
            );
          }}
          className="shrink-0 rounded px-2 py-1 text-xs font-medium text-blue-700 hover:bg-zinc-100 dark:text-blue-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </span>
  );
}
