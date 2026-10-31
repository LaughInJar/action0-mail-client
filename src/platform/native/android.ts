/**
 * The Android app's {@link Platform}: the same native sign-in and
 * networking as the desktop app, and Android's own: files for other apps,
 * links and shares that open the app, notifications from the background
 * check, and new releases on GitHub.
 */
import { addPluginListener } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AvailableRelease,
  OpenTarget,
  Platform,
  SharedContent,
} from "../types";
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

/** Where new releases are announced (the APK is on the release page). */
const LATEST_RELEASE =
  "https://api.github.com/repos/LaughInJar/action0-mail-client/releases/latest";

/** What the Kotlin side reports: a link or a share that opened the app. */
interface Incoming {
  readonly kind: "mailto" | "open" | "share";
  readonly url?: string;
  readonly text?: string | null;
  readonly subject?: string | null;
  readonly to?: readonly string[];
  readonly files?: readonly {
    readonly path: string;
    readonly name: string;
    readonly type: string;
  }[];
}

/** `action0://open?account=…&message=…` (a notification's tap). */
export function openTarget(url: string): OpenTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const accountId = parsed.searchParams.get("account");
  if (parsed.protocol !== "action0:" || !accountId) return null;
  const messageId = parsed.searchParams.get("message");
  return messageId ? { accountId, messageId } : { accountId };
}

/** True if version `a` ("1.2.3", a leading "v" allowed) is newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const parts = (version: string) =>
    version
      .replace(/^v/, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Starts the Android side: the platform, networking and kept accounts. */
export async function startAndroid(
  page: () => SignedInPage,
): Promise<NativeStart> {
  const auth = createAuthBridge(invoke, page);
  const imap = createNativeImapBridge(invoke, page);
  const [info, kept, permission, imapKept] = await Promise.all([
    invoke<{
      os: string;
      version: string;
      package: string;
      signatureHash: string;
      microsoftRedirect: string;
    }>("mobile_info"),
    auth.kept(),
    invoke<string>("mobile_notification_permission", { ask: false }).catch(
      () => "denied",
    ),
    imap.accounts().catch(() => ({ persistent: true, accounts: [] })),
  ]);
  const fetch = createNativeFetch(invoke);
  let notificationsGranted = permission === "granted";

  const composing = waiting<string>();
  const shares = waiting<SharedContent>();
  const opens = waiting<OpenTarget>();

  /** Shared files arrive as copies in the app's cache; each is read once. */
  const readShared = async (item: Incoming): Promise<SharedContent> => {
    const files = await Promise.all(
      (item.files ?? []).map(async (file) => {
        const bytes = await invoke<ArrayBuffer>("mobile_read_shared", {
          path: file.path,
        });
        return new File([bytes], file.name, { type: file.type });
      }),
    );
    return {
      ...(item.text ? { text: item.text } : {}),
      ...(item.subject ? { subject: item.subject } : {}),
      to: item.to ?? [],
      files,
    };
  };
  const handle = (item: Incoming) => {
    if (item.kind === "mailto" && item.url) composing.emit(item.url);
    else if (item.kind === "open" && item.url) {
      const target = openTarget(item.url);
      if (target) opens.emit(target);
    } else if (item.kind === "share")
      void readShared(item).then(shares.emit, () => undefined);
  };
  await addPluginListener<Incoming>("action0", "incoming", handle);
  // The web view doesn't report the navigation bar or the keyboard as safe
  // area: the page gets them as --a0-system-bottom (see index.css).
  const coverBottom = ({ bottom }: { bottom: number }) => {
    document.documentElement.style.setProperty(
      "--a0-system-bottom",
      `${String(bottom)}px`,
    );
  };
  await addPluginListener("action0", "insets", coverBottom);
  coverBottom(await invoke<{ bottom: number }>("plugin:action0|insets"));
  // What opened the app before the listener was there.
  const { items } = await invoke<{ items: Incoming[] }>(
    "plugin:action0|pending",
  );
  for (const item of items) handle(item);

  const openExternal = (url: string) => {
    void openUrl(url).catch(() => undefined);
  };
  const followLink = linkFollower(openExternal, composing.emit);
  catchLinks(followLink);

  const platform: Platform = {
    kind: "android",
    openExternal,
    followLink,
    saveFile: async (blob, name) => {
      const [bytes, options] = await fileRequest(blob, name);
      await invoke("mobile_save_file", bytes, options);
    },
    openFileLater: () => (file) => {
      if (!file) return;
      void fileRequest(file.blob, file.name, file.type).then(
        ([bytes, options]) => invoke("mobile_open_file", bytes, options),
      );
    },
    notifications: {
      supported: () => true,
      allowed: () => notificationsGranted,
      // Android 13+ asks; the bar asks once before it does.
      mustAsk: true,
      request: async () => {
        const answer = await invoke<string>("mobile_notification_permission", {
          ask: true,
        });
        notificationsGranted = answer === "granted";
        return notificationsGranted
          ? "granted"
          : answer === "denied"
            ? "denied"
            : "default";
      },
      // The background check notifies (also while the app is only in the
      // background); the app itself doesn't, so nothing comes twice.
      show: () => undefined,
    },
    // Android has no count on app icons; launchers show the notifications'.
    setUnreadCount: () => undefined,
    onPollRequest: () => () => undefined,
    onCompose: composing.subscribe,
    onShare: shares.subscribe,
    onOpen: opens.subscribe,
    mobile: {
      version: info.version,
      os: info.os,
      package: info.package,
      signatureHash: info.signatureHash,
      microsoftRedirect: info.microsoftRedirect,
      share: async (blob, name) => {
        const [bytes, options] = await fileRequest(blob, name);
        await invoke("mobile_share_file", bytes, options);
      },
      checkForUpdate: async (): Promise<AvailableRelease | null> => {
        try {
          const response = await fetch(LATEST_RELEASE, {
            headers: { accept: "application/vnd.github+json" },
          });
          if (!response.ok) return null;
          const release = (await response.json()) as {
            tag_name?: string;
            html_url?: string;
          };
          const version = release.tag_name?.replace(/^v/, "");
          return version && release.html_url && isNewer(version, info.version)
            ? { version, url: release.html_url }
            : null;
        } catch {
          return null;
        }
      },
      setTheme: (dark, background) => {
        void invoke("mobile_set_theme", { dark, background }).catch(
          () => undefined,
        );
      },
      configureBackground: async ({ enabled, texts }) => {
        await invoke("mobile_configure_background", { enabled, texts });
      },
    },
  };

  return {
    platform,
    fetch,
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
