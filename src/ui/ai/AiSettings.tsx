import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAiServices } from "../../ai/context";
import { AI_KINDS } from "../../ai/kinds";
import type { AiKind, AiServiceConfig } from "../../ai/types";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import { Icon } from "../common/Icon";
import { SettingsSection } from "../settings/controls";
import { AI_SETTINGS_ID, takeScrollRequest } from "./aiSettingsLink";
import { aiErrorText, aiModelsKey, serviceLabel, useAiSetUp } from "./useAi";

/** The kinds offered when adding a service, in this order. */
const ADDABLE: readonly Exclude<AiKind, "demo">[] = [
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "chatgpt",
  "ollama",
  "lmstudio",
  "compatible",
];

/** What another server's address looks like. */
const EXAMPLE_URL = "https://…/v1";

const HINT = "text-xs text-zinc-500 dark:text-zinc-400";
const FIELD =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 pointer-coarse:min-h-11";
const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800 pointer-coarse:min-h-11";
const PRIMARY =
  "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 pointer-coarse:min-h-11";

/** Query key of which services have a key or sign-in. */
const CREDENTIALS_KEY = ["ai", "credentials"] as const;

/** Settings → AI assistant: the services set up, and adding one. */
export function AiSettings() {
  const t = useT();
  const s = t.ai.settings;
  const services = useAiSetUp();
  const [adding, setAdding] = useState(false);
  const section = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (takeScrollRequest())
      section.current?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <SettingsSection id={AI_SETTINGS_ID} title={s.section}>
      <div ref={section} className="space-y-4 px-2">
        <p className={HINT}>{s.intro}</p>
        {services.length === 0 && !adding && (
          <p className="text-sm">{s.none}</p>
        )}
        {services.length > 0 && (
          <ul
            aria-label={s.services}
            className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800"
          >
            {services.map((service) => (
              <ServiceRow key={service.id} service={service} />
            ))}
          </ul>
        )}
        {adding ? (
          <AddService
            onDone={() => {
              setAdding(false);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
            }}
            className={`flex items-center gap-1.5 ${BUTTON}`}
          >
            <Icon name="plus" className="size-4" />
            {s.add}
          </button>
        )}
      </div>
    </SettingsSection>
  );
}

/** Which services have a key or sign-in (and whether they survive restarts). */
function useCredentials() {
  const ai = useAiServices();
  return useQuery({
    queryKey: CREDENTIALS_KEY,
    queryFn: () => ai.backend.credentials(),
  });
}

/** Adds, changes and drops services in the settings. */
function useServiceSettings() {
  const store = useUiStore();
  const queryClient = useQueryClient();
  return {
    add: (service: AiServiceConfig) => {
      const { settings, updateSettings } = store.getState();
      updateSettings({ aiServices: [...settings.aiServices, service] });
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY });
    },
    change: (service: AiServiceConfig) => {
      const { settings, updateSettings } = store.getState();
      updateSettings({
        aiServices: settings.aiServices.map((other) =>
          other.id === service.id ? service : other,
        ),
      });
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY });
    },
    drop: (service: AiServiceConfig) => {
      const { settings, updateSettings } = store.getState();
      const other = (id: string) => id !== service.id;
      updateSettings({
        aiServices: settings.aiServices.filter((s) => other(s.id)),
        aiChoices: Object.fromEntries(
          Object.entries(settings.aiChoices).filter(([, choice]) =>
            other(choice.service),
          ),
        ),
        aiRecent: settings.aiRecent.filter((choice) => other(choice.service)),
        aiNoticed: settings.aiNoticed.filter(other),
      });
      queryClient.removeQueries({ queryKey: aiModelsKey(service) });
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY });
    },
  };
}

function ServiceRow({ service }: { readonly service: AiServiceConfig }) {
  const t = useT();
  const s = t.ai.settings;
  const ai = useAiServices();
  const { data: credentials } = useCredentials();
  const settings = useServiceSettings();
  const kind = AI_KINDS[service.kind];
  const has = credentials?.ids.has(service.id) ?? true;
  const web = ai.backend.keeps === "browser";
  const usesKey =
    kind.setup === "key" ||
    service.kind === "openrouter" ||
    (service.kind === "compatible" && has);

  let status: string;
  if (service.kind === "chatgpt")
    status = has
      ? service.account
        ? s.signedInAs(service.account)
        : s.signedIn
      : s.signInNeeded;
  else if (kind.setup === "url") status = service.baseUrl ?? kind.baseUrl;
  else if (service.kind === "demo") status = s.kindHints.demo;
  else if (!has) status = s.keyNeeded;
  else if (web) status = service.remember ? s.keyRemembered : s.keySession;
  else status = credentials?.persistent === false ? s.keyUntilQuit : s.keyVault;

  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{serviceLabel(service, t)}</p>
          <p className={`${HINT} break-words`}>{status}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            void ai.backend.forget(service).catch(() => undefined);
            settings.drop(service);
          }}
          className={BUTTON}
        >
          {service.kind === "chatgpt" ? s.signOut : s.remove}
        </button>
      </div>
      {usesKey && web && (
        <label className="flex cursor-pointer items-start gap-2.5 pointer-coarse:min-h-11">
          <input
            type="checkbox"
            checked={service.remember === true}
            onChange={(event) => {
              const remember = event.target.checked;
              ai.backend.setRemember?.(service, remember);
              settings.change({ ...service, remember });
            }}
            className="mt-0.5 size-4 shrink-0 accent-blue-600"
          />
          <span className="text-sm">
            {s.remember}
            <span className={`block ${HINT}`}>{s.rememberHint}</span>
          </span>
        </label>
      )}
      {!has && kind.setup === "key" && <KeyAgain service={service} />}
      {!has && kind.setup === "signIn" && (
        <SignIn
          service={service}
          onDone={(account) => {
            settings.change({ ...service, ...(account ? { account } : {}) });
          }}
        />
      )}
    </li>
  );
}

/** A key entered again (the web app forgot it with the browser session). */
function KeyAgain({ service }: { readonly service: AiServiceConfig }) {
  const t = useT();
  const s = t.ai.settings;
  const ai = useAiServices();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const id = useId();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void ai.backend.saveKey(service, key.trim()).then(() => {
          setKey("");
          void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY });
          void queryClient.invalidateQueries({
            queryKey: aiModelsKey(service),
          });
        });
      }}
    >
      <label htmlFor={id} className="sr-only">
        {s.key}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        placeholder={s.key}
        value={key}
        onChange={(event) => {
          setKey(event.target.value);
        }}
        className={`min-w-0 flex-1 ${FIELD}`}
      />
      <button type="submit" disabled={!key.trim()} className={PRIMARY}>
        {s.save}
      </button>
    </form>
  );
}

/** True for a sign-in the user gave up (closed the window, cancelled). */
function cancelled(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const kind = (error as { kind?: unknown }).kind;
  return error.message === "closed" || kind === "cancelled";
}

/** Signing in at OpenRouter or ChatGPT; `onDone` gets who signed in (ChatGPT). */
function SignIn({
  service,
  onDone,
}: {
  readonly service: AiServiceConfig;
  readonly onDone: (account?: string) => void;
}) {
  const t = useT();
  const s = t.ai.settings;
  const ai = useAiServices();
  const [waiting, setWaiting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const attempt = useRef(0);
  const chatgpt = service.kind === "chatgpt";
  const start = () => {
    const mine = ++attempt.current;
    setWaiting(true);
    setFailure(undefined);
    const signIn = chatgpt
      ? ai.backend.signIn.chatgpt?.(service).then(({ account }) => account)
      : ai.backend.signIn.openrouter(service).then(() => undefined);
    void (signIn ?? Promise.reject(new Error("unavailable")))
      .then((account) => {
        if (mine !== attempt.current) return;
        setWaiting(false);
        onDone(account);
      })
      .catch((error: unknown) => {
        if (mine !== attempt.current) return;
        setWaiting(false);
        if (cancelled(error)) return;
        setFailure(
          error instanceof Error && error.message === "popup-blocked"
            ? s.popupBlocked
            : s.signInFailed(serviceLabel(service, t)),
        );
      });
  };
  return (
    <div className="space-y-2">
      {waiting ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {s.signingIn}
          <button
            type="button"
            onClick={() => {
              attempt.current++;
              setWaiting(false);
            }}
            className={BUTTON}
          >
            {s.stopWaiting}
          </button>
        </p>
      ) : (
        <button
          type="button"
          onClick={start}
          className={
            chatgpt
              ? "rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 pointer-coarse:min-h-11"
              : PRIMARY
          }
        >
          {chatgpt ? s.continueWithChatGpt : s.signInOpenRouter}
        </button>
      )}
      {failure && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {failure}
        </p>
      )}
    </div>
  );
}

/** Adding a service: its kind, then its key, sign-in or address, tested. */
function AddService({ onDone }: { readonly onDone: () => void }) {
  const t = useT();
  const s = t.ai.settings;
  const ai = useAiServices();
  const settings = useServiceSettings();
  const queryClient = useQueryClient();
  const web = ai.backend.keeps === "browser";
  const [kind, setKind] = useState<Exclude<AiKind, "demo">>("anthropic");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [remember, setRemember] = useState(false);
  const [testing, setTesting] = useState(false);
  const [failure, setFailure] = useState<string>();
  // One id per form, so a sign-in and its key end up under the same service.
  const [id] = useState(() => crypto.randomUUID());
  const info = AI_KINDS[kind];
  const kindName = useId();
  const keyId = useId();
  const urlId = useId();
  const nameId = useId();
  const config = (): AiServiceConfig => ({
    id,
    kind,
    ...(info.setup === "url" ? { baseUrl: (url || info.baseUrl).trim() } : {}),
    ...(kind === "compatible" && name.trim() ? { name: name.trim() } : {}),
    ...(web && remember && info.keyHeader ? { remember: true } : {}),
  });

  /** Checks the service answers (lists its models), then adds it. */
  const testAndAdd = async (service: AiServiceConfig, newKey: string) => {
    setTesting(true);
    setFailure(undefined);
    try {
      if (newKey) await ai.backend.saveKey(service, newKey);
      const models = await ai.client(service).models();
      queryClient.setQueryData(aiModelsKey(service), models);
      settings.add(service);
      onDone();
    } catch (error) {
      if (newKey) await ai.backend.forget(service).catch(() => undefined);
      setFailure(
        info.setup === "url" &&
          (error as { kind?: unknown } | null)?.kind === "unreachable"
          ? s.couldntConnect(serviceLabel(service, t))
          : aiErrorText(error, service, t),
      );
    } finally {
      setTesting(false);
    }
  };

  const signInDone = (account?: string) => {
    const service = { ...config(), ...(account ? { account } : {}) };
    if (kind === "chatgpt") {
      settings.add(service);
      onDone();
    } else void testAndAdd(service, "");
  };

  const chatgptHere = ai.backend.signIn.chatgpt !== undefined;
  const needsKey = info.setup === "key";
  const canTest =
    !testing &&
    (needsKey
      ? key.trim() !== ""
      : kind === "openrouter"
        ? key.trim() !== ""
        : info.setup === "url");

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <fieldset className="space-y-0.5">
        <legend className="mb-1.5 text-sm font-medium">{s.kind}</legend>
        {ADDABLE.map((candidate) => {
          const off = candidate === "chatgpt" && !chatgptHere;
          const hints = s.kindHints;
          return (
            <label
              key={candidate}
              className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 has-checked:bg-blue-50 dark:has-checked:bg-blue-500/15 pointer-coarse:min-h-11 ${off ? "opacity-60" : "cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800/60"}`}
            >
              <input
                type="radio"
                name={kindName}
                value={candidate}
                checked={kind === candidate}
                disabled={off}
                onChange={() => {
                  setKind(candidate);
                  setFailure(undefined);
                }}
                className="mt-0.5 size-4 shrink-0 accent-blue-600"
              />
              <span className="min-w-0 text-sm">
                {serviceLabel({ id: "", kind: candidate }, t)}
                <span className={`block ${HINT}`}>
                  {off ? hints.chatgptWeb : hints[candidate]}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <Note
        text={s.privacy[kind]}
        warn={kind === "gemini"}
        link={info.privacyUrl}
        linkLabel={s.privacyLink}
      />

      {kind === "compatible" && (
        <Field id={nameId} label={s.name}>
          <input
            id={nameId}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={FIELD}
          />
        </Field>
      )}
      {info.setup === "url" && (
        <Field id={urlId} label={s.url} hint={s.urlHint}>
          <input
            id={urlId}
            type="url"
            inputMode="url"
            placeholder={info.baseUrl || EXAMPLE_URL}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
            className={FIELD}
          />
        </Field>
      )}
      {info.setup === "signIn" && (
        <SignIn service={config()} onDone={signInDone} />
      )}
      {(needsKey || kind === "openrouter" || kind === "compatible") && (
        <Field
          id={keyId}
          label={
            kind === "openrouter"
              ? s.orKey
              : kind === "compatible"
                ? s.keyOptional
                : s.key
          }
        >
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
            }}
            className={FIELD}
          />
          {info.keyUrl && (
            <a
              href={info.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-xs text-blue-700 underline dark:text-blue-300"
            >
              {s.getKey}
            </a>
          )}
        </Field>
      )}
      {web && info.keyHeader && (
        <label className="flex cursor-pointer items-start gap-2.5 pointer-coarse:min-h-11">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => {
              setRemember(event.target.checked);
            }}
            className="mt-0.5 size-4 shrink-0 accent-blue-600"
          />
          <span className="text-sm">
            {s.remember}
            <span className={`block ${HINT}`}>{s.rememberHint}</span>
          </span>
        </label>
      )}
      {failure && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onDone} className={BUTTON}>
          {t.common.cancel}
        </button>
        {kind !== "chatgpt" && (
          <button
            type="button"
            disabled={!canTest}
            onClick={() => {
              void testAndAdd(config(), key.trim());
            }}
            className={PRIMARY}
          >
            {testing ? s.testing : s.testAndAdd}
          </button>
        )}
      </div>
    </div>
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
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  );
}

/** A service's privacy note, with a link to its policy. */
function Note({
  text,
  warn,
  link,
  linkLabel,
}: {
  readonly text: string;
  readonly warn: boolean;
  readonly link: string | undefined;
  readonly linkLabel: string;
}) {
  return (
    <p
      className={`rounded-md px-3 py-2 text-xs ${warn ? "bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}
    >
      {text}{" "}
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          {linkLabel}
        </a>
      )}
    </p>
  );
}
