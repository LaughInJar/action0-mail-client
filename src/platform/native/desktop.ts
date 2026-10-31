/** The desktop app's {@link Platform} (Linux, Windows, macOS). */
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as autostart from "@tauri-apps/plugin-autostart";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { Platform } from "../types";
import { createAuthBridge, type SignedInPage } from "./authBridge";
import {
  catchLinks,
  fileRequest,
  invoke,
  linkFollower,
  waiting,
  type NativeStart,
} from "./common";
import { createNativeAiBackend } from "./ai";
import { createNativeCaldavBridge } from "./caldav";
import { createNativeSieveBridge } from "./sieve";
import { createNativeImapBridge } from "./imap";
import { createNativeFetch } from "./nativeFetch";

/** Native events, with listeners added and removed synchronously. */
function relay(event: string): {
  readonly subscribe: (listener: (payload: unknown) => void) => () => void;
} {
  const listeners = new Set<(payload: unknown) => void>();
  void listen<unknown>(event, ({ payload }) => {
    for (const listener of [...listeners]) listener(payload);
  });
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function showWindow() {
  const window = getCurrentWindow();
  await window.unminimize();
  await window.show();
  await window.setFocus();
}

/** Draws the unread count for Windows' taskbar (a PNG). */
async function overlayPng(count: number): Promise<number[] | null> {
  if (count === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#dc2626";
  context.beginPath();
  context.arc(16, 16, 16, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#fff";
  context.font = `bold ${count > 99 ? "13" : "18"}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(count > 99 ? "99+" : String(count), 16, 17);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  return blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null;
}

/** Starts the desktop side: the platform, networking and kept accounts. */
export async function startDesktop(
  page: () => SignedInPage,
): Promise<NativeStart> {
  const auth = createAuthBridge(invoke, page);
  const imap = createNativeImapBridge(invoke, page);
  const [info, kept, compose, imapKept] = await Promise.all([
    invoke<{ os: string; version: string }>("shell_info"),
    auth.kept(),
    invoke<string[]>("shell_take_compose"),
    imap.accounts().catch(() => ({ persistent: true, accounts: [] })),
  ]);

  let notificationsGranted = await isPermissionGranted().catch(() => false);
  // Clicks on notifications, by notification id.
  const clicks = new Map<number, () => void>();
  let lastClick: (() => void) | undefined;
  let nextNotification = 1;
  void onAction(({ notification }) => {
    const click =
      notification?.id === undefined ? lastClick : clicks.get(notification.id);
    void showWindow().then(() => click?.());
  });

  // mailto: links (from the system, the tray, mails) wait for the first listener.
  const composing = waiting<string>();
  for (const link of compose) composing.emit(link);
  relay("a0://compose").subscribe((link) => {
    composing.emit(typeof link === "string" ? link : "");
  });
  const polls = relay("a0://poll");
  const imapChanges = relay("imap-changed");
  const closedToTray = relay("a0://closed-to-tray");
  const openExternal = (url: string) => {
    void openUrl(url).catch(() => undefined);
  };
  const followLink = linkFollower(openExternal, composing.emit);
  catchLinks(followLink);

  let unread = "";
  const platform: Platform = {
    kind: "desktop",
    openExternal,
    followLink,
    saveFile: async (blob, name) => {
      const path = await save({ defaultPath: name });
      if (path === null) return;
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    },
    openFileLater: () => (file) => {
      if (!file) return;
      void fileRequest(file.blob, file.name, file.type).then(
        ([bytes, options]) => invoke("shell_open_file", bytes, options),
      );
    },
    notifications: {
      supported: () => true,
      allowed: () => notificationsGranted,
      mustAsk: false,
      request: async () => {
        const permission = await requestPermission();
        notificationsGranted = permission === "granted";
        return permission;
      },
      show: ({ title, body, onClick }) => {
        const id = nextNotification++;
        clicks.set(id, onClick);
        lastClick = onClick;
        if (clicks.size > 50) clicks.delete(id - 50);
        if (!notificationsGranted) return;
        sendNotification({ id, title, body });
      },
    },
    setUnreadCount: (count, label) => {
      const key = `${String(count)}|${label}`;
      if (key === unread) return;
      unread = key;
      void (info.os === "windows" ? overlayPng(count) : Promise.resolve(null))
        .then((overlay) =>
          invoke("shell_set_unread", { count, tooltip: label, overlay }),
        )
        .catch(() => undefined);
    },
    // The tray asks, and IMAP's IDLE says an Inbox changed.
    onPollRequest: (listener) => {
      const stops = [polls, imapChanges].map((source) =>
        source.subscribe(() => {
          listener();
        }),
      );
      return () => {
        for (const stop of stops) stop();
      };
    },
    onCompose: composing.subscribe,
    desktop: {
      version: info.version,
      os: info.os,
      keychain: kept.persistent,
      configure: ({ closeToTray, texts }) => {
        void invoke("shell_configure", { closeToTray, texts }).catch(
          () => undefined,
        );
      },
      onClosedToTray: (listener) =>
        closedToTray.subscribe(() => {
          listener();
        }),
      autostart: {
        get: () => autostart.isEnabled(),
        set: (on) => (on ? autostart.enable() : autostart.disable()),
      },
      makeDefaultMailApp: () => invoke("shell_default_mail_app"),
      checkForUpdate: async () => {
        const update = await check().catch(() => null);
        return update
          ? {
              version: update.version,
              install: async () => {
                await update.downloadAndInstall();
                await relaunch();
              },
            }
          : null;
      },
      quit: () => {
        void invoke("shell_quit");
      },
    },
    // Only WebKitGTK lets the app choose; macOS and Windows decide themselves.
    ...(info.os === "linux"
      ? {
          spelling: {
            dictionaries: () => invoke<string[]>("spelling_dictionaries"),
            setLanguages: (languages: readonly string[]) =>
              invoke<string[]>("spelling_set_languages", { languages }),
          },
        }
      : {}),
  };

  return {
    platform,
    fetch: createNativeFetch(invoke),
    auth,
    accounts: new Map(kept.accounts.map((account) => [account.key, account])),
    ai: createNativeAiBackend(invoke, page),
    imap: {
      bridge: imap,
      accounts: new Map(
        imapKept.accounts.map((account) => [account.key, account]),
      ),
    },
    caldav: createNativeCaldavBridge(invoke),
    sieve: createNativeSieveBridge(invoke),
  };
}
