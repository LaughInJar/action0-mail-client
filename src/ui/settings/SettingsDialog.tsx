import { useId, useState } from "react";
import { UNDO_SEND_CHOICES, type AppSettings } from "../../state/settings";
import { useUi } from "../../state/context";
import type { ThemeMode } from "../../state/theme";
import { IconButton } from "../common/IconButton";
import { Sheet } from "../common/Sheet";
import { notificationsSupported } from "../sync/notifications";
import { ChoiceGroup, SettingsSection } from "./controls";
import { SignatureSettings } from "./SignatureSettings";

const SECTIONS = [
  { id: "settings-general", title: "General" },
  { id: "settings-reading", title: "Reading" },
  { id: "settings-writing", title: "Writing" },
  { id: "settings-notifications", title: "Notifications" },
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
  const set =
    <K extends keyof AppSettings>(key: K) =>
    (value: AppSettings[K]) => {
      update({ [key]: value });
    };

  return (
    <Sheet labelledBy={titleId} onEscape={onClose} size="page">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 py-2 pr-2 pl-4 dark:border-zinc-800">
        <h2 id={titleId} className="flex-1 text-base font-semibold">
          Settings
        </h2>
        <IconButton label="Close settings (Esc)" icon="x" onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="hidden w-40 shrink-0 space-y-0.5 border-r border-zinc-200 p-2 sm:block dark:border-zinc-800"
        >
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => {
                document
                  .getElementById(section.id)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="block w-full rounded-md px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {section.title}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6">
          <SettingsSection id="settings-general" title="General">
            <ChoiceGroup<ThemeMode>
              legend="Theme"
              value={theme}
              onChange={setTheme}
              choices={[
                {
                  value: "system",
                  label: "System",
                  hint: "Follows your device",
                },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
            <ChoiceGroup
              legend="Message list"
              value={settings.density}
              onChange={set("density")}
              choices={[
                {
                  value: "comfortable",
                  label: "Comfortable",
                  hint: "Two lines per message",
                },
                {
                  value: "compact",
                  label: "Compact",
                  hint: "One line per message, to see more at once",
                },
              ]}
            />
            <ChoiceGroup
              legend="After archiving or deleting the open message"
              value={settings.afterRemove}
              onChange={set("afterRemove")}
              choices={[
                { value: "below", label: "Open the next message below" },
                { value: "above", label: "Open the next message above" },
                {
                  value: "list",
                  label: "Go back to the list",
                  hint: "j and k continue from where the message was",
                },
              ]}
            />
          </SettingsSection>

          <SettingsSection id="settings-reading" title="Reading">
            <ChoiceGroup
              legend="Mark as read"
              value={settings.markRead}
              onChange={set("markRead")}
              choices={[
                { value: "immediately", label: "As soon as it opens" },
                {
                  value: "delay",
                  label: "After 1.5 seconds on screen",
                  hint: "Skimming with j and k doesn't mark everything",
                },
                {
                  value: "manual",
                  label: "Only by hand",
                  hint: "Shift+I, or the button above the message",
                },
              ]}
            />
            <ChoiceGroup
              legend="Remote images in mail"
              value={settings.remoteImages}
              onChange={set("remoteImages")}
              choices={[
                {
                  value: "ask",
                  label: "Ask every time",
                  hint: "Senders can't see when you read their mail",
                },
                {
                  value: "trusted",
                  label: "Ask, but remember senders I trust",
                  hint: "“Always from …” above a mail's blocked images",
                },
                {
                  value: "always",
                  label: "Always load them",
                  hint: "Senders can tell when and where you open their mail",
                },
              ]}
            >
              {settings.remoteImages === "trusted" && <TrustedSenders />}
            </ChoiceGroup>
          </SettingsSection>

          <SettingsSection id="settings-writing" title="Writing">
            <UndoSend
              value={settings.undoSendSeconds}
              onChange={set("undoSendSeconds")}
            />
            <SignatureSettings />
          </SettingsSection>

          <SettingsSection id="settings-notifications" title="Notifications">
            <Notifications
              enabled={settings.notifications}
              onChange={set("notifications")}
            />
          </SettingsSection>
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
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        Undo send
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
            {seconds === 0 ? "Off: send right away" : `${seconds} seconds`}
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
  if (trusted.length === 0)
    return (
      <p className="px-2 pt-1 text-xs text-zinc-500">No trusted senders yet.</p>
    );
  return (
    <ul aria-label="Trusted senders" className="space-y-0.5 pt-1 pl-8">
      {trusted.map((address) => (
        <li
          key={address}
          className="flex items-center gap-2 rounded-md text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        >
          <span className="min-w-0 flex-1 truncate">{address}</span>
          <button
            type="button"
            aria-label={`Remove ${address}`}
            onClick={() => {
              untrust(address);
            }}
            className="rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
          >
            Remove
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
  const supported = notificationsSupported();
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    supported ? Notification.permission : "denied",
  );
  const blocked = supported && permission === "denied";
  let note: string | undefined;
  if (!supported) note = "Phones only allow notifications for installed apps.";
  else if (blocked)
    note =
      "Your browser blocks notifications for this site. Allow them in the site settings (the icon left of the address), then reload.";
  else if (enabled && permission === "default")
    note = "Your browser hasn't been asked yet: switch them on to allow them.";

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
              void Notification.requestPermission().then(setPermission);
          }}
          className="mt-0.5 size-4 shrink-0 accent-blue-600"
        />
        <span className="text-sm">
          Desktop notifications for new mail
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Only new unread Inbox mail, and only while action0 isn't in front.
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
