/**
 * What differs between the web app and the desktop app: opening links and
 * files, notifications, the unread count on icons, and the desktop's own
 * controls. The UI only knows this interface; `web.ts` is the browser,
 * `desktop/` the Tauri app.
 */

/** A notification about new mail. */
export interface Notice {
  readonly title: string;
  readonly body: string;
  /** A notification with the same tag replaces the earlier one. */
  readonly tag: string;
  /** A click on it (the app comes forward first). */
  readonly onClick: () => void;
}

/** System notifications. */
export interface NotificationsPort {
  /** They can be shown at all here. */
  readonly supported: () => boolean;
  /** They may be shown (the user allowed them). */
  readonly allowed: () => boolean;
  /** Allowing them takes asking the user first (the browser's prompt). */
  readonly mustAsk: boolean;
  readonly request: () => Promise<NotificationPermission>;
  readonly show: (notice: Notice) => void;
}

/** A file to open with whatever shows it (e.g. a PDF viewer). */
export interface OpenedFile {
  readonly blob: Blob;
  readonly name: string;
  /** The media type it opens as. */
  readonly type: string;
}

/** A newer version of the desktop app. */
export interface AppUpdate {
  readonly version: string;
  /** Downloads and installs it, then restarts the app. */
  readonly install: () => Promise<void>;
}

/** Texts of the tray menu. */
export interface TrayTexts {
  readonly show: string;
  readonly compose: string;
  readonly quit: string;
}

/** How making action0 the default mail app went. */
export type DefaultMailAppResult = "done" | "settings" | "manual";

/** What only the desktop app has. */
export interface DesktopControls {
  readonly version: string;
  /** "linux", "windows", "macos". */
  readonly os: string;
  /** Closing the window keeps the app in the tray; the tray menu's texts. */
  readonly configure: (options: {
    readonly closeToTray: boolean;
    readonly texts: TrayTexts;
  }) => void;
  /** The window was closed into the tray. */
  readonly onClosedToTray: (listener: () => void) => () => void;
  readonly autostart: {
    readonly get: () => Promise<boolean>;
    readonly set: (on: boolean) => Promise<void>;
  };
  readonly makeDefaultMailApp: () => Promise<DefaultMailAppResult>;
  /** A newer version, if there is one (null if not, or offline). */
  readonly checkForUpdate: () => Promise<AppUpdate | null>;
  readonly quit: () => void;
}

/** See the module docs. */
export interface Platform {
  readonly kind: "web" | "desktop";
  /** Opens a web address outside the app (a new tab; the default browser). */
  readonly openExternal: (url: string) => void;
  /**
   * A link was clicked (in the app or in a mail): true if the platform
   * handled it, so the click does nothing else. The web app lets links
   * open as they do (new tabs); the desktop app opens web addresses in the
   * default browser and `mailto:` links in a new mail.
   */
  readonly followLink: (href: string) => boolean;
  /** Saves a file the user downloads. */
  readonly saveFile: (blob: Blob, name: string) => Promise<void>;
  /**
   * Starts opening a file: call it inside the click (popup blockers), then
   * hand over the file once it's loaded, or `null` if loading failed.
   */
  readonly openFileLater: () => (file: OpenedFile | null) => void;
  readonly notifications: NotificationsPort;
  /** The unread count of all inboxes, for the app's icons (`label` describes it). */
  readonly setUnreadCount: (count: number, label: string) => void;
  /** Asks the app to check for mail now (while it's hidden in the tray). */
  readonly onPollRequest: (listener: () => void) => () => void;
  /** Asks the app to write a mail: a `mailto:` link, or "" for an empty one. */
  readonly onCompose: (listener: (mailto: string) => void) => () => void;
  /** The desktop app's own controls. */
  readonly desktop?: DesktopControls;
}
