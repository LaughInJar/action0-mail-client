import type { Platform } from "./types";

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

/** The web app: new tabs, downloads and the browser's notifications. */
export const webPlatform: Platform = {
  kind: "web",
  openExternal: (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  followLink: () => false,
  saveFile: (blob, name) => {
    downloadBlob(blob, name);
    return Promise.resolve();
  },
  openFileLater: () => {
    // Open the tab inside the click (popup blockers), fill it once loaded.
    const tab = window.open("", "_blank");
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
    // Phones only show notifications from installed apps (service worker).
    supported: () =>
      typeof Notification !== "undefined" &&
      !window.matchMedia(COARSE_POINTER).matches,
    allowed: () =>
      typeof Notification !== "undefined" &&
      Notification.permission === "granted",
    mustAsk: true,
    request: () => Notification.requestPermission(),
    show: ({ title, body, tag, onClick }) => {
      try {
        const notification = new Notification(title, {
          body,
          tag,
          icon: "/favicon.svg",
        });
        notification.onclick = () => {
          window.focus();
          onClick();
          notification.close();
        };
      } catch {
        // Some browsers (Chrome on Android) only notify through a service worker.
      }
    },
  },
  // The tab title shows the count.
  setUnreadCount: () => undefined,
  onPollRequest: never,
  onCompose: never,
};
