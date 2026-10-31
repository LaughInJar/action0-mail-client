/**
 * The installable web app (PWA): the service worker (`src/sw/`), installing
 * the app, its updates, email links, and what the worker hands the page
 * (shared content, notification clicks). The web app only; the Tauri apps
 * have all of this natively.
 */
import { Emitter } from "../lib/emitter";
// Types only: code shared with the worker would end up in a chunk the
// worker can't load (the build refuses that).
import type { SharedForm, WorkerMessage } from "../sw/logic";
import type { PwaControls } from "./types";

/** Chrome's and Edge's install event (not in TypeScript's DOM types). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

/** How often the app asks whether there's a new version (besides at start and on return). */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** What the web platform uses of the PWA besides {@link PwaControls}. */
export interface Pwa {
  readonly controls: PwaControls;
  /** The page is controlled by the service worker (notifications go through it). */
  readonly controlled: () => boolean;
  /** The worker's registration, once it's ready (never without one). */
  readonly registration: () => Promise<ServiceWorkerRegistration>;
  /** Messages from the worker. */
  readonly onMessage: (listener: (data: unknown) => void) => () => void;
  /** The content shared with this id, once (null if the worker lost it). */
  readonly takeShare: (id: string) => Promise<SharedForm | null>;
}

/** Options of {@link startPwa}. */
export interface PwaOptions {
  /** Registers the service worker (production builds; the dev server has none). */
  readonly register: boolean;
  readonly window?: Window;
}

/**
 * Starts the installable web app: registers `/sw.js`, listens for the
 * install prompt and for new versions, and relays the worker's messages.
 */
export function startPwa({ register, window: win = window }: PwaOptions): Pwa {
  const emitter = new Emitter();
  const workers =
    "serviceWorker" in win.navigator ? win.navigator.serviceWorker : undefined;
  let prompt: BeforeInstallPromptEvent | undefined;
  let waiting: ServiceWorker | undefined;
  let reloading = false;
  const listeners = new Set<(data: unknown) => void>();

  win.addEventListener("beforeinstallprompt", (event) => {
    // Kept for "Install action0" instead of the browser's own banner.
    event.preventDefault();
    prompt = event as BeforeInstallPromptEvent;
    emitter.emit();
  });
  win.addEventListener("appinstalled", () => {
    prompt = undefined;
    emitter.emit();
  });

  const watch = (registration: ServiceWorkerRegistration) => {
    const check = () => {
      // A worker waiting while another one controls the page is a new version.
      if (registration.waiting && workers?.controller) {
        waiting = registration.waiting;
        emitter.emit();
      }
    };
    check();
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed") check();
      });
    });
    const update = () => {
      void registration.update().catch(() => undefined);
    };
    win.setInterval(update, UPDATE_CHECK_MS);
    win.document.addEventListener("visibilitychange", () => {
      if (win.document.visibilityState === "visible") update();
    });
  };

  if (workers && register) {
    workers.addEventListener("message", (event) => {
      for (const listener of listeners) listener(event.data);
    });
    workers.addEventListener("controllerchange", () => {
      // Only when the user asked for the new version.
      if (reloading) win.location.reload();
    });
    win.addEventListener("load", () => {
      void workers
        .register("/sw.js")
        .then(watch)
        .catch(() => undefined);
    });
  }

  const standalone = () =>
    win.matchMedia("(display-mode: standalone)").matches ||
    (win.navigator as Navigator & { standalone?: boolean }).standalone === true;

  const controls: PwaControls = {
    installed: standalone,
    canInstall: () => prompt !== undefined && !standalone(),
    install: async () => {
      const event = prompt;
      if (!event) return false;
      await event.prompt();
      const { outcome } = await event.userChoice;
      prompt = undefined;
      emitter.emit();
      return outcome === "accepted";
    },
    installSteps: () => {
      if (standalone()) return undefined;
      const agent = win.navigator.userAgent;
      const touchMac =
        agent.includes("Macintosh") && win.navigator.maxTouchPoints > 1;
      if (/iPhone|iPad|iPod/.test(agent) || touchMac) return "ios";
      // Safari on the Mac (not Chrome or Firefox, which say so too).
      if (
        agent.includes("Macintosh") &&
        /Version\/\d+.*Safari/.test(agent) &&
        !/Chrome|Chromium|Edg|Firefox/.test(agent)
      )
        return "macSafari";
      return undefined;
    },
    emailLinks: {
      supported: typeof win.navigator.registerProtocolHandler === "function",
      register: () => {
        win.navigator.registerProtocolHandler(
          "mailto",
          `${win.location.origin}/?mailto=%s`,
        );
      },
    },
    updateReady: () => waiting !== undefined,
    reload: () => {
      if (!waiting) return;
      reloading = true;
      const message: WorkerMessage = { type: "skip-waiting" };
      waiting.postMessage(message);
    },
    subscribe: (listener) => emitter.subscribe(listener),
  };

  return {
    controls,
    controlled: () => (workers?.controller ?? null) !== null,
    registration: () =>
      workers
        ? workers.ready
        : new Promise<ServiceWorkerRegistration>(() => undefined),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    takeShare: async (id) => {
      if (!workers) return null;
      const registration = await workers.ready;
      const active = registration.active;
      if (!active) return null;
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          resolve((event.data as SharedForm | null) ?? null);
        };
        const message: WorkerMessage = { type: "share", id };
        active.postMessage(message, [channel.port2]);
      });
    },
  };
}

/** A notification click relayed by the worker: its tag, if it's one. */
export function clickedTag(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Partial<
    Extract<WorkerMessage, { type: "notification-click" }>
  >;
  return message.type === "notification-click" &&
    typeof message.tag === "string"
    ? message.tag
    : undefined;
}
