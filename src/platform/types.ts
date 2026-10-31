/**
 * What differs between the web app, the desktop app and the Android app:
 * opening links and files, notifications, the unread count on icons,
 * content shared from other apps, and each app's own controls. The UI only
 * knows this interface; `web.ts` is the browser, `native/` the Tauri apps.
 */

/** A notification about new mail. */
export interface Notice {
  readonly title: string;
  readonly body: string;
  /** A notification with the same tag replaces the earlier one. */
  readonly tag: string;
  /** A click on it (the app comes forward first). */
  readonly onClick: () => void;
  /**
   * Where a click leads if the app has to open again first (the installed
   * web app, closed meanwhile): a page address with the route, e.g.
   * `/#/<account>/<mailbox>/<message>`.
   */
  readonly url?: string;
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

/**
 * The installable web app (PWA): installing it, its updates and email
 * links. The web app only.
 */
export interface PwaControls {
  /** It runs installed (its own window). */
  readonly installed: () => boolean;
  /** The browser offers installing it (Chrome, Edge, Android). */
  readonly canInstall: () => boolean;
  /** Asks the browser to install it; true if the user agreed. */
  readonly install: () => Promise<boolean>;
  /** Installing takes the browser's own menu here: Safari on iOS or the Mac. */
  readonly installSteps: () => "ios" | "macSafari" | undefined;
  /** `mailto:` links can open in action0 (the browser asks first). */
  readonly emailLinks: {
    readonly supported: boolean;
    readonly register: () => void;
  };
  /** A new version is ready to take over. */
  readonly updateReady: () => boolean;
  /** Switches to the new version (the page reloads). */
  readonly reload: () => void;
  /** Announces changes to the above. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** What only the desktop app has. */
export interface DesktopControls {
  readonly version: string;
  /** "linux", "windows", "macos". */
  readonly os: string;
  /**
   * Accounts stay signed in across restarts: the OS keychain keeps the
   * vault's key. Without one, they stay signed in only until quitting.
   */
  readonly keychain: boolean;
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

/** What another app shared into action0 (Android's "Share → action0"). */
export interface SharedContent {
  readonly text?: string;
  readonly subject?: string;
  /** Addresses to write to. */
  readonly to: readonly string[];
  readonly files: readonly File[];
}

/** A link that opened the app at an account or one of its messages. */
export interface OpenTarget {
  readonly accountId: string;
  readonly messageId?: string;
}

/** A newer version of the Android app, to download from its release page. */
export interface AvailableRelease {
  readonly version: string;
  readonly url: string;
}

/** The background check's notification texts, in the interface's language. */
export interface BackgroundTexts {
  /** `{count}` is replaced: "3 new messages". */
  readonly newMessages: string;
  readonly noSubject: string;
}

/** What only the Android app has. */
export interface MobileControls {
  readonly version: string;
  /** "android". */
  readonly os: string;
  /** The package name, as Google Cloud and Entra ask for it. */
  readonly package: string;
  /** The signing key's base64 SHA-1, as Google Cloud and Entra ask for it. */
  readonly signatureHash: string;
  /** Microsoft's redirect URI for this build (`msauth://…`). */
  readonly microsoftRedirect: string;
  /** Offers a file to other apps (the share sheet). */
  readonly share: (blob: Blob, name: string) => Promise<void>;
  /** A newer release, if there is one (null if not, or offline). */
  readonly checkForUpdate: () => Promise<AvailableRelease | null>;
  /** The system bars follow the app's theme (`background`: "#rrggbb"). */
  readonly setTheme: (dark: boolean, background: string) => void;
  /** Turns the check for new mail while the app isn't open on or off. */
  readonly configureBackground: (options: {
    readonly enabled: boolean;
    readonly texts: BackgroundTexts;
  }) => Promise<void>;
}

/** See the module docs. */
export interface Platform {
  readonly kind: "web" | "desktop" | "android";
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
  /** Content another app shared, to write a mail with (Android). */
  readonly onShare?: (listener: (shared: SharedContent) => void) => () => void;
  /** A link opened the app at a message (Android's notifications). */
  readonly onOpen?: (listener: (target: OpenTarget) => void) => () => void;
  /** The desktop app's own controls. */
  readonly desktop?: DesktopControls;
  /** The Android app's own controls. */
  readonly mobile?: MobileControls;
  /** The installable web app's own controls (the web app). */
  readonly pwa?: PwaControls;
  /**
   * Spell checking whose languages action0 sets (the Linux app). Elsewhere
   * the browser or the system decides, and Settings says where.
   */
  readonly spelling?: SpellingControls;
}

/** The languages the web view checks spelling in. */
export interface SpellingControls {
  /** The installed dictionaries, as language tags ("de-AT"). */
  readonly dictionaries: () => Promise<readonly string[]>;
  /** Checks with all of these at once; resolves to the ones that loaded. */
  readonly setLanguages: (
    languages: readonly string[],
  ) => Promise<readonly string[]>;
}
