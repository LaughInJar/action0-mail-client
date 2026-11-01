import type { HashRouter } from "../../state/router";

/** DOM id of Settings' templates part (in Writing). */
export const TEMPLATE_SETTINGS_ID = "settings-templates";

let scrollRequested = false;

/** Opens Settings at the templates ("Manage templates" in the composer). */
export function openTemplateSettings(router: HashRouter): void {
  scrollRequested = true;
  router.openSettings();
}

/** True once after {@link openTemplateSettings}: the part scrolls into view. */
export function takeTemplateScroll(): boolean {
  const requested = scrollRequested;
  scrollRequested = false;
  return requested;
}
