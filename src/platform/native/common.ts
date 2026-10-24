/** What the desktop and Android platforms share. */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeAccount, NativeAuthBridge } from "../../auth/native/bridge";
import type { Platform } from "../types";
import type { Invoke } from "./nativeFetch";

/** What the composition root gets from a native app. */
export interface NativeStart {
  readonly platform: Platform;
  /** Network requests through the native side (no CORS). */
  readonly fetch: typeof fetch;
  readonly auth: NativeAuthBridge;
  /** Accounts signed in at earlier starts, by account id. */
  readonly accounts: ReadonlyMap<string, NativeAccount>;
}

/** Tauri's `invoke`, with request headers. */
export const invoke: Invoke = (command, args, options) =>
  tauriInvoke(
    command,
    args,
    options?.headers ? { headers: options.headers } : undefined,
  );

/**
 * Things that arrive before anyone listens (a `mailto:` link that started
 * the app) wait for the first listener.
 */
export function waiting<T>(): {
  readonly emit: (value: T) => void;
  readonly subscribe: (listener: (value: T) => void) => () => void;
} {
  const queue: T[] = [];
  const listeners = new Set<(value: T) => void>();
  return {
    emit: (value) => {
      if (listeners.size === 0) queue.push(value);
      for (const listener of [...listeners]) listener(value);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      for (const value of queue.splice(0)) listener(value);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * What a click on a link does in a native app: web addresses open in the
 * browser, `mailto:` links in a new mail; anything else isn't followed.
 * True if it was handled (links of the app itself aren't).
 */
export function linkFollower(
  openExternal: (url: string) => void,
  compose: (mailto: string) => void,
): (href: string) => boolean {
  return (href) => {
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return true;
    }
    if (url.origin === window.location.origin) return false;
    if (url.protocol === "https:" || url.protocol === "http:")
      openExternal(url.href);
    else if (url.protocol === "mailto:") compose(url.href);
    // Anything else (file:, javascript:, other apps) isn't followed.
    return true;
  };
}

/** Links of the app itself (target=_blank) would open nothing in a web view. */
export function catchLinks(followLink: (href: string) => boolean): void {
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
}

/** A file for the native side: raw bytes, its name and type in headers. */
export async function fileRequest(
  blob: Blob,
  name: string,
  type = blob.type,
): Promise<[ArrayBuffer, { headers: Record<string, string> }]> {
  return [
    await blob.arrayBuffer(),
    {
      headers: {
        "x-a0-name": encodeURIComponent(name),
        "x-a0-type": encodeURIComponent(type),
      },
    },
  ];
}
