import { useId, useState } from "react";
import { UNDO_SEND_CHOICES, type AppSettings } from "../../state/settings";
import { useUi } from "../../state/context";
import type { ThemeMode } from "../../state/theme";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { usePlatform } from "../../platform/context";
import { AndroidSettings } from "./AndroidSettings";
import { DesktopSettings } from "./DesktopSettings";
import { ChoiceGroup, SettingsSection } from "./controls";
import { SignatureSettings } from "./SignatureSettings";
import { SpellingSettings } from "./SpellingSettings";
import { AiSettings } from "../ai/AiSettings";
import { AI_SETTINGS_ID } from "../ai/aiSettingsLink";
import { useT } from "../../i18n/context";
import {
  browserLanguages,
  LANGUAGE_NAMES,
  resolveLanguage,
  type LanguageSetting,
} from "../../i18n/locale";

/** The sections, by DOM id and text key. */
const SECTIONS = [
  ["settings-general", "general"],
  ["settings-reading", "reading"],
  ["settings-writing", "writing"],
  ["settings-notifications", "notifications"],
] as const;

/**
 * Settings: a large dialog on wider screens, a page of its own on phones.
 * Changes apply right away; app settings stay in this browser, signatures
 * are saved with the account.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const settings = useUi((state) => state.settings);
  const update = useUi((state) => state.updateSettings);
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const t = useT();
  const s = t.settings;
  const { desktop, mobile } = usePlatform();
  const named = SECTIONS.map(([id, key]) => [id, s[key]] as const);
  const sections: (readonly [string, string])[] = [
    // The AI assistant after Writing.
    ...named.slice(0, 3),
    [AI_SETTINGS_ID, t.ai.settings.section],
    ...named.slice(3),
    ...(desktop || mobile
      ? [["settings-app", t.desktop.section] as const]
      : []),
  ];
  const set =
    <K extends keyof AppSettings>(key: K) =>
    (value: AppSettings[K]) => {
      update({ [key]: value });
    };

  return (
    <Sheet labelledBy={titleId} onEscape={onClose} size="page">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-2 pr-2 pl-4 dark:border-zinc-800">
        <h2 id={titleId} className="flex-1 text-base font-semibold">
          {s.title}
        </h2>
        <IconButton label={s.close} icon="x" onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={s.sections}
          className="hidden w-40 shrink-0 space-y-0.5 border-r border-zinc-200 p-2 sm:block dark:border-zinc-800"
        >
          {sections.map(([id, title]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                document
                  .getElementById(id)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="block w-full rounded-md px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {title}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6">
          <SettingsSection id="settings-general" title={s.general}>
            <ChoiceGroup<LanguageSetting>
              legend={s.language}
              value={settings.language}
              onChange={set("language")}
              choices={[
                {
                  value: "auto",
                  label: s.automatic,
                  hint: s.followsBrowser(
                    LANGUAGE_NAMES[resolveLanguage("auto", browserLanguages())],
                  ),
                },
                { value: "en", label: LANGUAGE_NAMES.en, lang: "en" },
                { value: "de", label: LANGUAGE_NAMES.de, lang: "de" },
              ]}
            />
            <ChoiceGroup<ThemeMode>
              legend={t.layout.theme}
              value={theme}
              onChange={setTheme}
              choices={[
                {
                  value: "system",
                  label: t.layout.themeSystem,
                  hint: s.themeHint,
                },
                { value: "light", label: t.layout.themeLight },
                { value: "dark", label: t.layout.themeDark },
              ]}
            />
            <ChoiceGroup
              legend={s.messageList}
              value={settings.density}
              onChange={set("density")}
              choices={[
                {
                  value: "comfortable",
                  label: s.comfortable,
                  hint: s.comfortableHint,
                },
                {
                  value: "compact",
                  label: s.compact,
                  hint: s.compactHint,
                },
              ]}
            />
            <ChoiceGroup
              legend={s.afterRemove}
              value={settings.afterRemove}
              onChange={set("afterRemove")}
              choices={[
                { value: "below", label: s.openBelow },
                { value: "above", label: s.openAbove },
                {
                  value: "list",
                  label: s.backToList,
                  hint: s.backToListHint,
                },
              ]}
            />
          </SettingsSection>

          <SettingsSection id="settings-reading" title={s.reading}>
            <ChoiceGroup
              legend={s.conversationView}
              value={settings.conversations ? "on" : "off"}
              onChange={(value) => {
                update({ conversations: value === "on" });
              }}
              choices={[
                { value: "off", label: s.off, hint: s.offHint },
                { value: "on", label: s.on, hint: s.onHint },
              ]}
            />
            <ChoiceGroup
              legend={s.markRead}
              value={settings.markRead}
              onChange={set("markRead")}
              choices={[
                { value: "immediately", label: s.immediately },
                {
                  value: "delay",
                  label: s.afterDelay,
                  hint: s.afterDelayHint,
                },
                {
                  value: "manual",
                  label: s.manually,
                  hint: s.manuallyHint,
                },
              ]}
            />
            <ChoiceGroup
              legend={s.remoteImages}
              value={settings.remoteImages}
              onChange={set("remoteImages")}
              choices={[
                { value: "ask", label: s.askAlways, hint: s.askAlwaysHint },
                {
                  value: "trusted",
                  label: s.askTrusted,
                  hint: s.askTrustedHint,
                },
                {
                  value: "always",
                  label: s.loadAlways,
                  hint: s.loadAlwaysHint,
                },
              ]}
            >
              {settings.remoteImages === "trusted" && <TrustedSenders />}
            </ChoiceGroup>
          </SettingsSection>

          <SettingsSection id="settings-writing" title={s.writing}>
            <SpellingSettings />
            <UndoSend
              value={settings.undoSendSeconds}
              onChange={set("undoSendSeconds")}
            />
            <SignatureSettings />
          </SettingsSection>

          <AiSettings />
          <SettingsSection id="settings-notifications" title={s.notifications}>
            <Notifications
              enabled={settings.notifications}
              onChange={set("notifications")}
            />
            <label className="flex cursor-pointer items-start gap-2.5 px-2 pointer-coarse:min-h-11">
              <input
                type="checkbox"
                checked={settings.eventReminders}
                onChange={(event) => {
                  update({ eventReminders: event.target.checked });
                }}
                className="mt-0.5 size-4 shrink-0 accent-blue-600"
              />
              <span className="text-sm">
                {s.eventReminders}
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                  {s.eventRemindersHint}
                </span>
              </span>
            </label>
          </SettingsSection>
          {desktop && <DesktopSettings id="settings-app" desktop={desktop} />}
          {mobile && <AndroidSettings id="settings-app" mobile={mobile} />}
        </div>
      </div>
    </Sheet>
  );
}

function UndoSend({
  value,
  onChange,
}: {
  value: AppSettings["undoSendSeconds"];
  onChange: (value: AppSettings["undoSendSeconds"]) => void;
}) {
  const id = useId();
  const s = useT().settings;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {s.undoSend}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          const seconds = UNDO_SEND_CHOICES.find(
            (choice) => String(choice) === event.target.value,
          );
          if (seconds !== undefined) onChange(seconds);
        }}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 pointer-coarse:min-h-11"
      >
        {UNDO_SEND_CHOICES.map((seconds) => (
          <option key={seconds} value={seconds}>
            {seconds === 0 ? s.sendRightAway : s.seconds(seconds)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The senders whose remote images load without asking, removable. */
function TrustedSenders() {
  const trusted = useUi((state) => state.settings.trustedSenders);
  const untrust = useUi((state) => state.untrustSender);
  const t = useT();
  if (trusted.length === 0)
    return (
      <p className="px-2 pt-1 text-xs text-zinc-500">
        {t.settings.noTrustedSenders}
      </p>
    );
  return (
    <ul
      aria-label={t.settings.trustedSenders}
      className="space-y-0.5 pt-1 pl-8"
    >
      {trusted.map((address) => (
        <li
          key={address}
          className="flex items-center gap-2 rounded-md text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        >
          <span className="min-w-0 flex-1 truncate">{address}</span>
          <button
            type="button"
            aria-label={t.settings.removeSender(address)}
            onClick={() => {
              untrust(address);
            }}
            className="rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
          >
            {t.common.remove}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Desktop notifications: the setting, and what the browser allows. Turning
 * them on asks the browser (inside the click, as browsers require).
 */
function Notifications({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { notifications, mobile } = usePlatform();
  const supported = notifications.supported();
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    !supported
      ? "denied"
      : notifications.allowed()
        ? "granted"
        : notifications.mustAsk && typeof Notification !== "undefined"
          ? Notification.permission
          : "default",
  );
  const blocked = supported && permission === "denied";
  const t = useT();
  const s = t.settings;
  let note: string | undefined;
  if (!supported) note = s.phonesOnly;
  else if (blocked)
    note = mobile ? t.android.notificationsBlocked : s.notificationsBlocked;
  else if (enabled && permission === "default") note = s.notAskedYet;

  return (
    <div className="space-y-1">
      <label className="flex cursor-pointer items-start gap-2.5 px-2 pointer-coarse:min-h-11">
        <input
          type="checkbox"
          checked={enabled && permission === "granted"}
          disabled={!supported || blocked}
          onChange={(event) => {
            const on = event.target.checked;
            onChange(on);
            if (on && permission === "default")
              void notifications.request().then(setPermission);
          }}
          className="mt-0.5 size-4 shrink-0 accent-blue-600"
        />
        <span className="text-sm">
          {mobile ? t.android.notifications : s.desktopNotifications}
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            {mobile ? t.android.notificationsHint : s.desktopNotificationsHint}
          </span>
        </span>
      </label>
      {note && (
        <p
          role="note"
          className="px-2 text-xs text-zinc-600 dark:text-zinc-400"
        >
          {note}
        </p>
      )}
    </div>
  );
}
