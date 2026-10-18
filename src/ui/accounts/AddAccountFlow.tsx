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
import { useT } from "../../i18n/context";
import { RichText } from "../common/RichText";

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
  const a = useT().accounts;

  /** Connects (must run inside the click), then opens the new Inbox. */
  const connect = (type: ProviderType): Promise<void> => {
    const known = new Set(registry.list().map((h) => h.account.id));
    return registry.add(type).then(async (handle: AccountHandle) => {
      const { id, email } = handle.account;
      store.getState().showToast({
        message: known.has(id) ? a.reconnected(email) : a.connected(email),
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
  const t = useT();
  const a = t.accounts;

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
    <StepFrame titleId={titleId} title={a.addAccount}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{a.whichKind}</p>
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
                    setError(errorMessage(cause, t));
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
                <span className="block font-medium">
                  {a.types[card.type].title}
                </span>
                <span className="block text-sm text-zinc-500">
                  {a.types[card.type].description}
                </span>
              </span>
              {status === "coming-later" && (
                <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">
                  {a.comingLater}
                </span>
              )}
              {status === "needs-setup" && (
                <span className="shrink-0 text-xs text-zinc-500">
                  {a.oneTimeSetup}
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
  const a = useT().accounts;
  const links = Object.fromEntries(
    Object.entries(GOOGLE_CLOUD_LINKS).map(([name, href]) => [
      name,
      (text: string) => <ExternalLink href={href}>{text}</ExternalLink>,
    ]),
  );

  const save = () => {
    if (!setup) return;
    const problem = setup.validate(value);
    setError(problem && a.setupProblems[problem]);
    if (problem !== undefined) return;
    setup.apply(value);
    onSaved();
  };

  return (
    <StepFrame titleId={titleId} title={a.setUpGoogle} onBack={onBack}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{a.setupIntro}</p>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {a.setupSteps.map((step) => (
          <li key={step}>
            <RichText
              text={step}
              tags={{ ...links, origin: () => <CopyableOrigin /> }}
            />
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
          placeholder={CLIENT_ID_EXAMPLE}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
        />
        <ErrorNote id={errorId} message={error} />
        <p className="text-xs text-zinc-500">{a.clientIdNote}</p>
        <button type="submit" className={PRIMARY_BUTTON}>
          {a.saveAndContinue}
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
  const t = useT();
  const a = t.accounts;
  const tags = {
    origin: () => <CopyableOrigin />,
    audience: (text: string) => (
      <ExternalLink href={GOOGLE_CLOUD_LINKS.audience}>{text}</ExternalLink>
    ),
  };

  // Load Google's sign-in script first, so the popup opens inside the click.
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

  let label = error === undefined ? a.continueWithGoogle : t.common.tryAgain;
  if (!ready) label = a.loadingGoogle;
  else if (busy) label = a.waitingForGoogle;

  return (
    <StepFrame titleId={titleId} title={a.connectGoogle} onBack={onBack}>
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
        {a.connectNotes.map((note) => (
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
          {a.googleError}
        </summary>
        <dl className="mt-2 space-y-2">
          <HelpItem term={a.helpOrigin}>
            <RichText text={a.helpOriginText} tags={tags} />
          </HelpItem>
          <HelpItem term={a.helpBlocked}>
            <RichText text={a.helpBlockedText} tags={tags} />
          </HelpItem>
          <HelpItem term={a.helpAdmin}>{a.helpAdminText}</HelpItem>
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

/** What a client ID looks like (the same in every language). */
const CLIENT_ID_EXAMPLE = "1234567890-abc123.apps.googleusercontent.com";

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
  const a = useT().accounts;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {onBack && (
          <button
            type="button"
            aria-label={a.back}
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
  const a = useT().accounts;
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
          {copied ? a.copied : a.copy}
        </button>
      )}
    </span>
  );
}
