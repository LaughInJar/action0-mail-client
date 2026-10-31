# Development

This document gets you from a fresh clone to a running app, and explains the conventions that the compiler, ESLint, Prettier and code review hold every change to. It also walks through the three most common small changes (a text, a shortcut, a setting) and the mandatory way features are planned, built and merged. Setting up the Google and Microsoft OAuth clients is described in the [README](../README.md#setting-up-google-sign-in) and isn't repeated here.

- [Prerequisites](#prerequisites)
- [First run](#first-run)
- [Scripts](#scripts)
- [Code conventions](#code-conventions)
- [Adding UI text](#adding-ui-text)
- [Adding a keyboard shortcut](#adding-a-keyboard-shortcut)
- [Adding a setting](#adding-a-setting)
- [Working on the desktop app](#working-on-the-desktop-app)
- [Workflow](#workflow)

How the code is organised is explained in [architecture.md](architecture.md), how to test it in [testing.md](testing.md).

## Prerequisites

| Tool                    | Version                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js                 | 22.12 or newer (`engines` in `package.json`). CI uses the version in `.nvmrc` (24), so that's the safest choice (`nvm use` picks it up).   |
| npm                     | The one that comes with Node. npm is the project's package manager: the lockfile is `package-lock.json`, and CI installs with `npm ci`.    |
| Rust (desktop app only) | 1.90 or newer (`rust-version` in `src-tauri/Cargo.toml`, edition 2024). CI uses the latest stable toolchain with `clippy` and `rustfmt`.   |
| Chrome or Chromium      | Optional, for the [manual checks in headless Chrome](testing.md#manual-checks-in-headless-chrome). Tests themselves run in jsdom and Node. |

The desktop app also needs the system libraries Tauri builds against. On Debian/Ubuntu, CI installs these (`.github/workflows/ci.yml`):

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
```

The README lists the Gentoo packages ([Running and building](../README.md#running-and-building)); for macOS and Windows see Tauri's [prerequisites](https://v2.tauri.app/start/prerequisites/). The web app needs none of this.

## First run

```sh
git clone git@github.com:LaughInJar/action0-mail-client.git
cd action0-mail-client
npm ci
npm run dev
```

Then open <http://localhost:5173/?demo>.

### `.env.local`

Optional. Without it the app still runs: the demo works, and **Add account** shows the Google and Microsoft setup checklists with a field for the client ID. To build your own client IDs into the app instead, copy `.env.example` to `.env.local` (it's in `.gitignore`) and fill in what you need. `src/app/config.ts` reads these values (declared in `src/vite-env.d.ts`); each is trimmed, and an empty value counts as not set.

| Variable                            | What it is                                                                                     | Entered in the app instead (localStorage key)                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `VITE_GOOGLE_CLIENT_ID`             | The web app's Google OAuth client (type _Web application_). Not used by the desktop app.       | **Add account → Google** (`a0.settings.googleClientId`)                         |
| `VITE_MICROSOFT_CLIENT_ID`          | The Microsoft Entra app's client ID, for the web app and the desktop app.                      | **Add account → Microsoft** (`a0.settings.microsoftClientId`)                   |
| `VITE_GOOGLE_DESKTOP_CLIENT_ID`     | Desktop app only: the Google client of type _Desktop app_. Used only together with its secret. | **Add account → Google** in the desktop app (`a0.settings.googleDesktopClient`) |
| `VITE_GOOGLE_DESKTOP_CLIENT_SECRET` | Desktop app only: that client's secret (not confidential for desktop clients).                 | Same as above                                                                   |

A value from `.env.local` takes precedence over one entered in the app: `src/app/services.ts` picks `config.googleClientId ?? storedGoogleClientId(localStorage)`, and the same for the others. The values are compiled into the build through `import.meta.env`, so they end up in `dist/`; none of them is confidential. The release workflow can build the Microsoft and Google desktop clients into the desktop app from repository variables and secrets (see [releasing.md](releasing.md)).

The only other `import.meta.env` value the code reads is Vite's own `BASE_URL`, for the path of `redirect.html` (where Microsoft's sign-in returns). `vite.config.ts` doesn't set `base`, so it's `/`.

### The dev server

`npm run dev` serves the app on <http://localhost:5173>. The port is fixed (`server.port: 5173` with `strictPort: true` in `vite.config.ts`, and the same for `npm run preview`), because it is part of the OAuth registrations: Google's _Authorized JavaScript origin_ is `http://localhost:5173`, and Microsoft's SPA redirect URI is `http://localhost:5173/redirect.html`. If the port is taken, Vite stops with an error instead of moving to another port, which would only fail later at sign-in. Open it as `localhost`, not `127.0.0.1`, for the same reason.

The dev server runs without the app's Content Security Policy: the `action0:csp` plugin in `vite.config.ts` adds it only to builds, because hot reloading needs inline scripts. To check something against the real CSP, run `npm run build && npm run preview`.

To try the app on a phone, see [Testing on a phone](../README.md#testing-on-a-phone).

### The installable web app

The service worker is registered only by production builds: the dev server has none (hot reload and a worker that keeps files don't mix). To try installing, offline start, the update bar, email links or sharing, run `npm run build && npm run preview` (same port, so sign-in works), then use Chrome's install icon or DevTools → Application.

### Demo mode

Opening the app with `?demo` connects two demo accounts without any sign-in (`src/main.tsx` removes the parameter, adds the first account if it isn't there yet, then adds the second with `AccountRegistry.addKnown`). Both are backed by the in-memory `FakeMailProvider` (`src/providers/fake/`):

| Account             | Works like                                        | Data                                                                             |
| ------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `demo@example.com`  | Gmail: labels                                     | `demoData.ts`, with a sample calendar (`demoCalendar.ts`) and an invitation mail |
| `demo@work.example` | Outlook: folders with Outlook's names, categories | `demoWork.ts`; no calendars                                                      |

Every demo call waits 150 ms (`latencyMs` in `src/providers/fake/module.ts`) so loading states are visible, and new mail arrives every two minutes (every three in the second account), so live updates can be tried. With two accounts the app also shows **All inboxes**. The demo's mail lives only in memory and is created fresh when the page loads. **Add account → Demo account** connects the first demo account too.

## Scripts

The README's [Scripts](../README.md#scripts) table lists every script. The ones you'll use most:

- `npm run dev`: the dev server (above).
- `npm test` runs all tests once; `npm run test:watch` keeps watching. To run one file or one test: `npx vitest run src/ui/actions.test.tsx -t "rolls back"`.
- `npm run typecheck`: `tsc -b` over both TypeScript projects (not in the README table).
- `npm run format` formats everything with Prettier, Markdown included.
- `npm run check` runs `typecheck`, `lint`, `format:check`, `test` and `build`: exactly the Node steps of CI's `check` job. Run it before handing work over.

For the desktop app, CI also runs these in `src-tauri/` (run them after `npm run check`, which builds `dist/`):

```sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

## Code conventions

### TypeScript

`tsconfig.app.json` (everything in `src/`) and `tsconfig.node.json` (`vite.config.ts`) both use `strict` plus stricter checks. The ones that shape everyday code:

- **`noUncheckedIndexedAccess`**: `list[0]` and `record[key]` are `T | undefined`. Handle the `undefined` (`list[0]?.id`, `?? fallback`). The non-null assertion `!` is a lint error outside tests.
- **`exactOptionalPropertyTypes`**: an optional property may be missing, but can't be set to `undefined`. Leave it out instead, usually with a conditional spread:

  ```ts
  ...(desktop ? { platform: desktop.platform } : {}),
  ```

- **`verbatimModuleSyntax`** (with the lint rules `consistent-type-imports` and `consistent-type-exports`): type-only imports are written `import type { … }` or `import { type … }`.
- **`erasableSyntaxOnly`**: no `enum`, no `namespace`, no constructor parameter properties. Use string unions and `as const` objects.
- Both also set `noUnusedLocals` and `noUnusedParameters`; `tsconfig.app.json` adds `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride` and `noUncheckedSideEffectImports`.

IDs are branded strings (`src/core/ids.ts`: `MessageId`, `MailboxId`, …), so the compiler keeps them apart. They are opaque: only the provider that issued an ID or a cursor interprets it. Create them with `asMessageId(…)` and friends, in providers and tests.

### ESLint

`eslint.config.js` combines `typescript-eslint`'s `strictTypeChecked` and `stylisticTypeChecked` (type-aware, through `projectService`), `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh` and `eslint-plugin-jsx-a11y`'s strict rules. `npm run lint` passes `--max-warnings 0`, so warnings fail it too. A few rules on top: `switch-exhaustiveness-check`, `eqeqeq`, `no-console` (only `console.warn` and `console.error` are allowed), and `prefer-nullish-coalescing` with strings exempt (`value || fallback` is meant for empty strings).

**Import boundaries.** The layers only meet through interfaces (see [architecture.md](architecture.md)); `no-restricted-imports` enforces the parts that can be checked:

| Files                                                                 | Must not import                                                                                      | Why                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/ui`, `src/data`, `src/state`, `src/keyboard`, `src/compose`      | `**/providers/**`, `**/auth/google/**`, `**/auth/microsoft/**`, `**/auth/native/**`, `@tauri-apps/*` | They know only the provider-agnostic contracts in `src/core`. Providers are wired in `src/app`. |
| Everything else in `src`, except `src/platform/native` and `src/core` | `@tauri-apps/*`                                                                                      | Only the native platforms talk to Tauri; the rest uses the `Platform` interface.                |
| `src/core`                                                            | `react`, `react-dom`, `@tanstack/*`, `zustand`, `../*` (anything outside `src/core`)                 | Pure contracts and rules, with no dependencies.                                                 |
| Tests (`*.test.ts(x)`) and `src/test`                                 | (no restrictions)                                                                                    | Tests may wire up the in-memory provider directly, and may use `!`.                             |

**Untranslated text.** In `src/ui` (tests excluded), `no-restricted-syntax` flags words of two or more letters written directly into the code: JSX text; the attributes `aria-label`, `aria-description`, `title`, `placeholder`, `alt`, `label`, `legend`, `backdropLabel`, `confirmLabel` and `hint`; and object properties named `message`, `title`, `label`, `hint`, `description` or `confirmLabel` (toasts, confirmations). Template strings and both branches of `?:` and `||` are checked too. The fix is always the catalogue: see [Adding UI text](#adding-ui-text).

**React hooks.** The config uses the plugin's `recommended-latest` preset (version 7), which adds the React Compiler's checks to `rules-of-hooks` and `exhaustive-deps`: among others `purity`, `refs`, `immutability`, `set-state-in-effect`, `set-state-in-render`, `static-components` and `preserve-manual-memoization`. The build doesn't run the React Compiler itself (`vite.config.ts` only has the plain React plugin), so memoizing is still done by hand with `useMemo` and `useCallback` where it matters, for example for the command lists given to `useCommands`.

**Tauri.** Only `src/platform/native` imports `@tauri-apps/*`. It's loaded with `import()` only inside the desktop or Android app, so the web bundle doesn't carry it.

### Prettier

Prettier formats everything (`prettier --write .`), Markdown and JSON included; `.prettierignore` skips `dist`, `coverage`, `package-lock.json`, `src-tauri/target` and `src-tauri/gen`. `.prettierrc.json` keeps Prettier's defaults and adds `prettier-plugin-tailwindcss`, which sorts Tailwind classes. With Tailwind 4 the theme lives in CSS, so the plugin is pointed at `src/index.css` (`tailwindStylesheet`). `.editorconfig` sets two-space indentation, LF line endings and a final newline. Don't hard-wrap prose in Markdown. Rust code is formatted with `cargo fmt`.

### Comments and TSDoc

Public interfaces, types, functions and their members get TSDoc comments (`/** … */`, with `{@link …}` to related symbols). No lint rule checks this; review does. Comments say what something is for and why, in plain sentences. Look at `src/core/provider.ts` or `src/state/uiStore.ts` for the tone.

### Function-typed properties

Interfaces whose members get passed around as functions (subscribe, store actions, the router, `Platform`) declare them as function-typed properties, not methods. With method syntax, `@typescript-eslint/unbound-method` would flag every place that destructures them or hands them on, such as `const { helpOpen, setHelpOpen } = store.getState()`. From `src/state/uiStore.ts`:

```ts
export interface UiActions {
  readonly setHelpOpen: (open: boolean) => void;
  /** Shows a toast, replacing the current one. */
  readonly showToast: (toast: Omit<Toast, "id" | "createdAt">) => void;
}
```

Classes do the same with arrow-function fields where a member gets passed on, as `CommandRegistry` does for `subscribe` (given to `useSyncExternalStore`) and `handleKeyDown`:

```ts
subscribe = (listener: () => void): (() => void) =>
  this.#emitter.subscribe(listener);
```

### Tests next to the code

`foo.ts` is tested in `foo.test.ts` beside it. UI tests that render the whole app live in `src/ui/` and are named after the feature (`src/ui/composer.test.tsx`). Shared helpers are in `src/test/`. Details in [testing.md](testing.md).

## Adding UI text

Everything the interface says comes from the catalogue in `src/i18n/`; ESLint flags text written into `src/ui` directly (see above).

1. **Pick the area file** in `src/i18n/texts/` (`composer.ts`, `settings.ts`, …). Each file has an `en` object and a `de` object typed `typeof en`, so a German text that's missing or has the wrong shape fails the typecheck. A new area file also needs an entry under both `en` and `de` in `src/i18n/messages.ts`.
2. **Write the English text, then the German one.** German uses "du". Texts with values are functions; in German the parameter types come from `typeof en`. From `src/i18n/texts/unsubscribe.ts`:

   ```ts
   const en = {
     title: (sender: string) => `Unsubscribe from ${sender}?`,
     confirm: "Unsubscribe",
   };

   const de: typeof en = {
     title: (sender) => `${sender} abbestellen?`,
     confirm: "Abbestellen",
   };
   ```

3. **Read it with `useT()`** (`src/i18n/context.ts`) in a component or hook: `const t = useT();` then `t.unsubscribe.title(sender)`. Code outside React can use `ENGLISH` from the same file.
4. **Plurals** use `plural(n, one, other)` from `src/i18n/plural.ts` inside the text function; English and German both have just these two forms. From `src/i18n/texts/common.ts`:

   ```ts
   messages: (n: number) => plural(n, "1 message", `${n} messages`),
   ```

5. **Dates and numbers** are formatted with `Intl` in the interface's locale, `t.locale` (for example `de-AT`, so Austrian German writes "Jänner"). The helpers in `src/ui/common/format.ts` take it: `formatListDate(date, { locale: t.locale })`. `src/i18n/locale.ts` decides the language and the locale from the setting and the browser.
6. **Errors** are `MailError`s (`src/core/errors.ts`), the only error type providers and auth sessions reject with. When the app knows the cause, it sets a `reason` (and `params` for values), which the interface shows in its own language instead of the English `message`:

   ```ts
   throw new MailError("provider", "One-click unsubscribe needs https.", {
     reason: "needsHttps",
   });
   ```

   A new reason goes into the `MailErrorReason` union and into both `Reasons` records in `src/i18n/texts/errors.ts` (typed `Record<MailErrorReason, …>`, so a missing text fails the typecheck). The UI shows any error with `errorMessage(error, t)` from `src/ui/common/errorMessage.ts`: a known reason in the interface's language, otherwise the message as it is (for example Gmail's own error text, which isn't translated).

Shortcut keys, the demo's sample mails, the README and code comments stay in English.

## Adding a keyboard shortcut

Shortcuts are commands in a central registry (`src/keyboard/registry.ts`). Components register them while they're mounted, so a shortcut exists exactly when the part of the interface it belongs to is on screen.

1. **Register in the component that owns the action**, with `useCommands` (`src/keyboard/context.ts`). Pass a memoized array, and read state that changes inside `when` and `run` (for example through `store.getState()`), so the array stays stable. From `src/ui/actions/useActionCommands.ts`:

   ```ts
   {
     id: "mail.archive",
     group,
     description: s.archive,
     keys: ["a"],
     when: () => actions.canArchive && hasTargets(),
     run: () => {
       actions.archive();
     },
   },
   ```

2. **Fill in the `Command`:**
   - `id`: unique, `area.action`.
   - `group`: the section of the shortcut help (`list`, `actions`, `reading`, `goTo`, `search`, `writing`, `calendar`, `general`).
   - `description`: a text from `t.shortcuts` ([Adding UI text](#adding-ui-text)).
   - `keys`: one or more bindings in the notation of `src/keyboard/keys.ts`. Printable characters match the character they type, so Shift is implied (`"shift+i"` normalizes to `"I"`, and `"?"` works on any layout); named keys spell modifiers out (`"shift+Delete"`, `"ctrl+q"`, `"meta+q"`). A space separates the strokes of a sequence: `"g i"`.
   - `when` (optional): the command only runs while this returns true.
   - `run`: the action.
3. **Know how keys are dispatched.** `src/app/AppProviders.tsx` installs one `keydown` listener for the whole app, and mail iframes forward their key presses to the registry (`src/ui/reader/SafeHtmlFrame.tsx`). Keys are ignored while a modal dialog is open (`aria-modal="true"` outside an `inert` region), inside an element marked `data-own-keys` (such as the composer), in text fields and rich-text editors, and Space and Enter stay with a focused button or link. When bindings collide, the most recently registered command whose `when` is true wins. A started sequence waits `SEQUENCE_TIMEOUT_MS` (one second) for its next stroke; if the next stroke doesn't continue it, that stroke is handled on its own.
4. **The help dialog** (<kbd>?</kbd>, `src/ui/help/ShortcutHelp.tsx`) is generated from the registry: every registered command, grouped in the order of `GROUP_ORDER`, with key names from `t.shortcuts.keys`. A new group needs an entry in `CommandGroup`, in `GROUP_ORDER` and in `t.shortcuts.groups`.
5. **Follow the existing scheme**: go-to shortcuts are `g` then a letter (`g i`, `g c`), and `a` on its own is reserved for archive. Every shortcut also needs a way to do the same by mouse and touch.
6. **Update the README's [Keyboard shortcuts](../README.md#keyboard-shortcuts) table.** Registry behaviour is unit-tested in `src/keyboard/registry.test.ts`; in UI tests, press keys with `await user.keyboard("a")` or `"{Shift>}u{/Shift}"`.

## Adding a setting

App settings are per browser and live in the UI store. Settings that belong to an account (Gmail signatures) are saved with the provider instead.

1. **Define it** in `src/state/settings.ts`: a field with a TSDoc comment in `AppSettings`, its default in `DEFAULT_SETTINGS`, and a line in `parseSettings`, which turns whatever is stored into valid settings (an invalid or missing value gets the default). Choices use the `oneOf` helper:

   ```ts
   const isDensity = oneOf(["comfortable", "compact"] as const);
   // in parseSettings:
   density: isDensity(raw.density) ? raw.density : d.density,
   ```

2. **Persistence comes with it.** `createUiStore` (`src/state/uiStore.ts`) persists `settings` (with column widths, tree expansion, the list order, reminder marks and account colours) to localStorage under `a0.ui` (`UI_STATE_KEY`), using Zustand's `persist` with `version: 1`. On load, `merge` runs the stored settings through `parseSettings`, so a new field needs no migration. Bump `version` only together with a `migrate` function: without one, Zustand discards stored state whose version differs. Tests that preseed settings write `version: 1` too (for example `renderApp` and `src/ui/settings.test.tsx`), so they'd need the same change. The theme is the exception: it has its own key (`a0.theme`, `src/state/theme.ts`), mirrored in `public/theme.js` so it applies before the first paint.
3. **Read and change it**: `useUi((state) => state.settings.density)` in components, `store.getState().settings` inside callbacks, and `updateSettings({ density: "compact" })` to change it.
4. **Show it** in `src/ui/settings/SettingsDialog.tsx`, in the fitting section (General, Reading, Writing, Notifications); settings only the desktop app has go into `DesktopSettings.tsx` (the App section). `ChoiceGroup` (`src/ui/settings/controls.tsx`) renders a set of choices with hints; an on/off setting can be a checkbox, like **Event reminders**. Changes apply immediately; there is no Save button. The texts go into `src/i18n/texts/settings.ts`.
5. **Test it**: parsing in `src/state/settings.test.ts`, persistence in `src/state/uiStore.test.ts`, the dialog in `src/ui/settings.test.tsx`.
6. **Keep the rules**: browser storage holds settings and UI state, never tokens or mail content (see [security.md](security.md)). Mention the setting in the README's feature list and, if it stores something new, in its "What is stored where" table.

## Working on the desktop app

`npm run app:dev` runs `tauri dev`: it starts `npm run dev` itself (`beforeDevCommand` in `src-tauri/tauri.conf.json`) and opens the app window on `devUrl`, `http://localhost:5173`, so the interface hot-reloads as in the browser. Because Vite never moves to another port, stop a dev server that's already running on 5173 first. Vite ignores `src-tauri/` (`server.watch.ignored`); the Rust side is rebuilt by Tauri. `npm run app:build` builds installers for the current system (see [building-and-deploying.md](building-and-deploying.md)).

The interface finds out where it runs in `src/main.tsx`: inside an app (`"__TAURI_INTERNALS__" in window`) it loads `src/platform/native` with `import()` and calls `startNative()`, which starts `desktop.ts` or, on Android, `android.ts`. Either returns its `Platform`, a native `fetch`, the native sign-in bridge and the accounts kept from earlier starts. The Android app's commands and its Kotlin side are in [android.md](android.md). Everything else in the UI only sees the `Platform` interface (`src/platform/types.ts`; the browser's is `src/platform/web.ts`).

Where TypeScript meets Rust:

| TypeScript                                                                                    | Rust (`src-tauri/src/`)                                                                              | What                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/platform/native/nativeFetch.ts`                                                          | `net.rs`: `net_fetch`, `net_abort`                                                                   | Network requests made natively (no CORS). Bodies cross as raw bytes, the rest in an `x-a0-request` header.                        |
| `src/platform/native/authBridge.ts`, `src/auth/native/` (`bridge.ts`, `NativeAuthSession.ts`) | `oauth/`: `auth_accounts`, `auth_connect`, `auth_sign_in`, `auth_token`, `auth_sign_out`; `vault.rs` | Sign-in in the system browser with PKCE and a loopback redirect. Refresh tokens stay on the Rust side; the UI gets access tokens. |
| `src/platform/native/desktop.ts`                                                              | `shell.rs`: `shell_*` commands; events `a0://poll`, `a0://compose`, `a0://closed-to-tray`            | Tray, unread count, `mailto:`, opening files, quitting, default mail app.                                                         |
| `src/platform/native/desktop.ts`                                                              | Tauri plugins (opener, dialog, fs, notification, autostart, updater, process)                        | Links, Save dialog, notifications, start with the system, updates.                                                                |

A new native command is a `#[tauri::command]` registered in `generate_handler!` in `src-tauri/src/lib.rs` (desktop and Android have their own lists), called with `invoke` from `src/platform/native`, and offered to the UI through the `Platform` interface (with a web implementation in `src/platform/web.ts` and the test fakes in `src/test/desktopPlatform.ts` and `src/test/androidPlatform.ts`). Calling another plugin API also needs its permission in `src-tauri/capabilities/desktop.json` or `android.json`, which grant exactly the plugins action0 uses on each. Native sign-in errors arrive as `{ kind, message }` and become a `NativeAuthError` (`toNativeError` in `authBridge.ts`).

The desktop app has its own Content Security Policy in `src-tauri/tauri.conf.json`. Its `connect-src` allows only the IPC bridge (`ipc: http://ipc.localhost`), so the app's requests to mail and calendar servers go through `net_fetch`. The `action0:csp` Vite plugin leaves desktop builds alone.

The desktop app needs its own OAuth registrations ([Signing in from the desktop app](../README.md#signing-in-from-the-desktop-app)). How the native side works is described in [desktop-app.md](desktop-app.md), how releases are built and signed in [releasing.md](releasing.md).

## Workflow

`CLAUDE.md` holds the project's rules (it's also what Claude Code reads). Every feature goes through four steps, one feature at a time, without skipping or merging steps:

1. **Plan**: discuss and plan the feature with the user, then wait for explicit approval.
2. **Code outline**: show the planned changes as a diff or a detailed outline with comments, discuss, and wait for explicit approval.
3. **Implement**: build it and run `npm run check` (for the desktop app also the cargo commands under [Scripts](#scripts)). Then ask the user to try it, with a checklist of everything to test and, for each item, how (demo or real account, exact steps, what should happen). Say what the automated tests and the headless browser couldn't verify. Wait until the user confirms it works.
4. **Commit and push**: only after step 3 is confirmed. Push the feature branch and open a pull request.

Whenever a decision is needed, the user gets multiple-choice options with the recommended one first. Approved decisions are recorded in the **Decisions log** at the end of `CLAUDE.md`, newest last, one line each with a short rationale; that log is authoritative, and [decisions.md](decisions.md) explains the reasoning behind the bigger ones. `docs/` is kept current: when a change affects what it describes, update it with the change.

**Branches and pull requests.** Each feature gets its own branch, named `feature/<name>` (for example `feature/outlook-categories`), and its own pull request into `main`. `main` is protected: changes only arrive through pull requests (admins included), the CI job `check` must pass, and the user merges. Merges are GitHub merge commits ("Merge pull request #22 from LaughInJar/feature/outlook-categories"), and the pull request's title is the feature commit's subject.

**Commit messages** follow the style of `git log`:

- The subject is a short summary in plain English, without a type prefix or a final period. It names the feature ("Outlook categories as labels") or the area and the change ("Calendar: event reminders", "Reminder tests: don't depend on the clock's seconds").
- The body is prose, wrapped at about 72 columns: what changes for the user first, then technical points and consequences worth knowing ("so Microsoft accounts reconnect once").
- A feature is usually one commit; fixes found later on the same branch get commits of their own ("All inboxes tests: room for the composer's autosave").
- Commits made with Claude Code end with its `Co-Authored-By:` and `Claude-Session:` trailers.
