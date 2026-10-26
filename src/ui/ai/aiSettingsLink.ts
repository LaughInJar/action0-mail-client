import type { HashRouter } from "../../state/router";

/** DOM id of Settings' AI assistant section. */
export const AI_SETTINGS_ID = "settings-ai";

let scrollRequested = false;

/** Opens Settings at the AI assistant (to fix a key or sign in again). */
export function openAiSettings(router: HashRouter): void {
  scrollRequested = true;
  router.openSettings();
}

/** True once after {@link openAiSettings}: the section scrolls into view. */
export function takeScrollRequest(): boolean {
  const requested = scrollRequested;
  scrollRequested = false;
  return requested;
}
