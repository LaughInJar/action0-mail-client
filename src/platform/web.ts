import type { Pwa } from "./pwa";
import { clickedTag } from "./pwa";
import type { Platform, SharedContent } from "./types";

const COARSE_POINTER = "(pointer: coarse)";
const never = () => () => undefined;

/**
 * Saves a file. The type is forced to `application/octet-stream`, so the
 * browser never renders it (an HTML file can't run in the app's origin).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([blob], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "attachment";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

/** Notices shown through the service worker, by tag, waiting for a click. */
const MAX_PENDING_CLICKS = 50;

/**
 * What the start address asked for: `?mailto=…` (an email link) or
 * `?compose` (the "New mail" shortcut), and `?share=<id>` (Android's
 * share target). They're taken out of the address, so a reload doesn't
 * repeat them.
 */
function takeStartRequest(win: Window): {
  readonly compose?: string;
  readonly share?: string;
} {
  const url = new URL(win.location.href);
  const mailto = url.searchParams.get("mailto");
  const compose = url.searchParams.has("compose") ? "" : undefined;
  const share = url.searchParams.get("share") ?? undefined;
  if (mailto === null && compose === undefined && share === undefined)
    return {};
  for (const name of ["mailto", "compose", "share"])
    url.searchParams.delete(name);
  win.history.replaceState(win.history.state, "", url);
  return {
    ...(mailto !== null ? { compose: mailto } : {}),
    ...(compose !== undefined ? { compose } : {}),
    ...(share !== undefined ? { share } : {}),
  };
}

/**
 * The web app: new tabs, downloads and the browser's notifications. With
 * the installable web app's service worker (`pwa`), notifications go
 * through it (phones only allow that), the unread count goes on the app's
 * icon, and email links, the "New mail" shortcut and shared content start
 * a mail.
 */
export function createWebPlatform(pwa?: Pwa, win: Window = window): Platform {
  const start = pwa ? takeStartRequest(win) : {};
  let pendingCompose = start.compose;
  // Fetched from the worker right away; handed to whoever listens then.
  let sharedContent =
    pwa && start.share !== undefined
      ? pwa.takeShare(start.share).then((form): SharedContent | null => {
          if (!form) return null;
          const text = [form.text, form.url].filter(Boolean).join("\n");
          return {
            ...(form.title ? { subject: form.title } : {}),
            ...(text ? { text } : {}),
            to: [],
            files: form.files,
          };
        })
      : undefined;
  let shareListener: ((shared: SharedContent) => void) | undefined;
  /** onClick of notices shown through the worker, by tag. */
  const clicks = new Map<string, () => void>();
  pwa?.onMessage((data) => {
    const tag = clickedTag(data);
    const onClick = tag === undefined ? undefined : clicks.get(tag);
    if (!onClick) return;
    clicks.delete(tag ?? "");
    win.focus();
    onClick();
  });
  const throughWorker = () => pwa?.controlled() === true;

  return {
    kind: "web",
    openExternal: (url) => {
      win.open(url, "_blank", "noopener,noreferrer");
    },
    followLink: () => false,
    saveFile: (blob, name) => {
      downloadBlob(blob, name);
      return Promise.resolve();
    },
    openFileLater: () => {
      // Open the tab inside the click (popup blockers), fill it once loaded.
      const tab = win.open("", "_blank");
      if (tab) tab.opener = null;
      return (file) => {
        if (!file) {
          tab?.close();
          return;
        }
        if (!tab) {
          downloadBlob(file.blob, file.name);
          return;
        }
        // The type is forced: whatever the file really is, it shows as that.
        const url = URL.createObjectURL(
          new Blob([file.blob], { type: file.type }),
        );
        tab.location.href = url;
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 60_000);
      };
    },
    notifications: {
      // Phones only show notifications through a service worker.
      supported: () =>
        typeof Notification !== "undefined" &&
        (throughWorker() || !win.matchMedia(COARSE_POINTER).matches),
      allowed: () =>
        typeof Notification !== "undefined" &&
        Notification.permission === "granted",
      mustAsk: true,
      request: () => Notification.requestPermission(),
      show: ({ title, body, tag, onClick, url }) => {
        if (pwa && throughWorker()) {
          clicks.delete(tag);
          clicks.set(tag, onClick);
          for (const old of [...clicks.keys()].slice(
            0,
            Math.max(0, clicks.size - MAX_PENDING_CLICKS),
          ))
            clicks.delete(old);
          void pwa
            .registration()
            .then((registration) =>
              registration.showNotification(title, {
                body,
                tag,
                icon: "/icons/icon-192.png",
                data: { tag, url: url ?? "/" },
              }),
            )
            .catch(() => undefined);
          return;
        }
        try {
          const notification = new Notification(title, {
            body,
            tag,
            icon: "/favicon.svg",
          });
          notification.onclick = () => {
            win.focus();
            onClick();
            notification.close();
          };
        } catch {
          // Some browsers (Chrome on Android) only notify through a service worker.
        }
      },
    },
    // The tab title shows the count; an installed app's icon too.
    setUnreadCount: (count) => {
      // Not every browser has the Badging API, whatever the types say.
      if (!pwa || !("setAppBadge" in win.navigator)) return;
      const done =
        count > 0
          ? win.navigator.setAppBadge(count)
          : win.navigator.clearAppBadge();
      void done.catch(() => undefined);
    },
    onPollRequest: never,
    onCompose: (listener) => {
      if (pendingCompose !== undefined) {
        const mailto = pendingCompose;
        pendingCompose = undefined;
        // After the subscriber's setup.
        queueMicrotask(() => {
          listener(mailto);
        });
      }
      return () => undefined;
    },
    ...(pwa
      ? {
          onShare: (listener: (shared: SharedContent) => void) => {
            shareListener = listener;
            const coming = sharedContent;
            sharedContent = undefined;
            void coming?.then((shared) => {
              if (shared) shareListener?.(shared);
            });
            return () => {
              if (shareListener === listener) shareListener = undefined;
            };
          },
          pwa: pwa.controls,
        }
      : {}),
  };
}

/** The web app without the installable app's service worker (tests, the dev server). */
export const webPlatform: Platform = createWebPlatform();
