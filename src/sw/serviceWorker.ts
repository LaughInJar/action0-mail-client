/// <reference lib="webworker" />
/**
 * action0's service worker (the web app only, production builds): keeps
 * the app's own files so it starts offline, hands over content shared to
 * the installed app, and brings notification clicks back to the app. It
 * never stores API answers or mail: everything but the app's own files
 * goes to the network untouched.
 *
 * The build fills in the file list and version (`action0:sw` in
 * `vite.config.ts`).
 */
import {
  cacheName,
  CACHE_PREFIX,
  handlingOf,
  isMessage,
  readShare,
  type SharedForm,
} from "./logic";

declare const self: ServiceWorkerGlobalScope;

const FILES = JSON.parse("__A0_FILES__") as readonly string[];
const VERSION = "__A0_VERSION__";
const CACHE = cacheName(VERSION);
const files = new Set(FILES);

/** Shared content waiting for the page, by id (memory only). */
const shares = new Map<string, SharedForm>();

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(
          FILES.map((path) => new Request(path, { cache: "reload" })),
        ),
      ),
  );
  // The first version takes over at once; later ones wait for Reload.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  switch (handlingOf(request, self.location.origin, files)) {
    case "cached":
      event.respondWith(
        caches
          .match(request, { ignoreSearch: true })
          .then((found) => found ?? fetch(request)),
      );
      return;
    case "page":
      event.respondWith(
        fetch(request).catch(async () => {
          const page = await caches.match("/index.html");
          return page ?? Response.error();
        }),
      );
      return;
    case "share":
      event.respondWith(
        (async () => {
          const id = crypto.randomUUID();
          shares.set(id, readShare(await request.formData()));
          return Response.redirect(`/?share=${id}`, 303);
        })(),
      );
      return;
    case "network":
      return;
  }
});

self.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (isMessage(data, "skip-waiting")) {
    void self.skipWaiting();
    return;
  }
  if (isMessage(data, "share")) {
    const shared = shares.get(data.id);
    shares.delete(data.id);
    event.ports[0]?.postMessage(shared ?? null);
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { tag, url } = (event.notification.data ?? {}) as {
    readonly tag?: string;
    readonly url?: string;
  };
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const open = windows[0];
      if (open) {
        await open.focus();
        open.postMessage({ type: "notification-click", tag: tag ?? "" });
        return;
      }
      await self.clients.openWindow(url ?? "/");
    })(),
  );
});
