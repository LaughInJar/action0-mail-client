import type { UiStore } from "./uiStore";

/**
 * This browser's (or app's) id for Send later, made and kept with the
 * settings the first time it's needed. Mail it scheduled is sent by it
 * first; other action0s wait a moment (see `core/schedule.ts`).
 */
export function deviceIdOf(store: UiStore): string {
  const { settings, updateSettings } = store.getState();
  if (settings.deviceId) return settings.deviceId;
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  updateSettings({ deviceId: id });
  return id;
}
