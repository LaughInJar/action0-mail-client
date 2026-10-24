/**
 * The desktop app's {@link Platform}, over Tauri: loaded with `import()`
 * only when running in the app, so the web bundle doesn't carry it.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
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
import type { NativeAccount, NativeAuthBridge } from "../../auth/native/bridge";
import type { Platform } from "../types";
import { createAuthBridge, type SignedInPage } from "./authBridge";
import { createNativeFetch, type Invoke } from "./nativeFetch";

/** What the composition root gets from the desktop app. */
export interface DesktopStart {
  readonly platform: Platform;
  /** Network requests through the native side (no CORS). */
  readonly fetch: typeof fetch;
  readonly auth: NativeAuthBridge;
  /** Accounts signed in at earlier starts, by account id. */
  readonly accounts: ReadonlyMap<string, NativeAccount>;
}

const invoke: Invoke = (command, args, options) =>
  tauriInvoke(
    command,
    args,
    options?.headers ? { headers: options.headers } : undefined,
  );

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
): Promise<DesktopStart> {
  const auth = createAuthBridge(invoke, page);
  const [info, kept, compose] = await Promise.all([
    invoke<{ os: string; version: string }>("shell_info"),
    auth.kept(),
    invoke<string[]>("shell_take_compose"),
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
  const waiting = [...compose];
  const composeListeners = new Set<(mailto: string) => void>();
  const composeHere = (mailto: string) => {
    if (composeListeners.size === 0) waiting.push(mailto);
    for (const listener of [...composeListeners]) listener(mailto);
  };
  relay("a0://compose").subscribe((link) => {
    composeHere(typeof link === "string" ? link : "");
  });
  const polls = relay("a0://poll");
  const closedToTray = relay("a0://closed-to-tray");
  const openExternal = (url: string) => {
    void openUrl(url).catch(() => undefined);
  };
  const followLink = (href: string): boolean => {
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return true;
    }
    if (url.origin === window.location.origin) return false;
    if (url.protocol === "https:" || url.protocol === "http:")
      openExternal(url.href);
    else if (url.protocol === "mailto:") composeHere(url.href);
    // Anything else (file:, javascript:, other apps) isn't followed.
    return true;
  };
  // Links of the app itself (target=_blank) would open nothing in a web view.
  document.addEventListener(
    "click",
    (event) => {
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (link && !event.defaultPrevented && followLink(link.href))
        event.preventDefault();
    },
    true,
  );

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
      void file.blob.arrayBuffer().then((bytes) =>
        invoke("shell_open_file", bytes, {
          headers: { "x-a0-name": encodeURIComponent(file.name) },
        }),
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
    onPollRequest: (listener) =>
      polls.subscribe(() => {
        listener();
      }),
    onCompose: (listener) => {
      composeListeners.add(listener);
      for (const link of waiting.splice(0)) listener(link);
      return () => {
        composeListeners.delete(listener);
      };
    },
    desktop: {
      version: info.version,
      os: info.os,
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
  };

  return {
    platform,
    fetch: createNativeFetch(invoke),
    auth,
    accounts: new Map(kept.accounts.map((account) => [account.key, account])),
  };
}
