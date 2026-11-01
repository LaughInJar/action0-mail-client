import { useAccounts } from "../../accounts/context";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import type { HashRouter } from "../../state/router";
import { AI_SETTINGS_ID } from "../ai/aiSettingsLink";
import { FILTER_SETTINGS_ID } from "../filters/filterLink";

/** A section of Settings: its DOM id and title. */
export type SettingsSectionEntry = readonly [id: string, title: string];

/** Settings' sections in their order, as the side navigation lists them. */
export function useSettingsSections(): readonly SettingsSectionEntry[] {
  const t = useT();
  const s = t.settings;
  const { desktop, mobile, pwa } = usePlatform();
  const filters = useAccounts().some((handle) => handle.filters);
  return [
    ["settings-general", s.general],
    ["settings-reading", s.reading],
    ["settings-writing", s.writing],
    // Filters and the AI assistant after Writing.
    ...(filters ? [[FILTER_SETTINGS_ID, t.filters.section] as const] : []),
    [AI_SETTINGS_ID, t.ai.settings.section],
    ["settings-notifications", s.notifications],
    ...(desktop || mobile
      ? [["settings-app", t.desktop.section] as const]
      : pwa
        ? [["settings-app", t.pwa.appTitle] as const]
        : []),
  ];
}

let scrollRequest: string | null = null;

/** Opens Settings at one of its sections (from the command palette). */
export function openSettingsAt(router: HashRouter, sectionId: string): void {
  scrollRequest = sectionId;
  router.openSettings();
}

/** The section {@link openSettingsAt} asked for, once. */
export function takeSectionScroll(): string | null {
  const requested = scrollRequest;
  scrollRequest = null;
  return requested;
}
