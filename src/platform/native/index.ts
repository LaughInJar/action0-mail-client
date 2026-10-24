/**
 * The native apps' {@link Platform}s, over Tauri: loaded with `import()`
 * only when running in an app, so the web bundle doesn't carry them.
 */
import type { SignedInPage } from "./authBridge";
import type { NativeStart } from "./common";

export type { NativeStart } from "./common";

/** Starts the native side of the app this runs in: Android or desktop. */
export async function startNative(
  page: () => SignedInPage,
): Promise<NativeStart> {
  return /\bAndroid\b/.test(navigator.userAgent)
    ? (await import("./android")).startAndroid(page)
    : (await import("./desktop")).startDesktop(page);
}
