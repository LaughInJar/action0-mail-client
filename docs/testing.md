# Testing

action0 is tested at four levels: pure functions, provider adapters against mocked HTTP, the whole interface rendered against an in-memory provider, and the desktop app's Rust side. Provider APIs are always mocked; no test ever reaches Google or Microsoft. This document explains where each kind of test lives, the helpers in `src/test/`, the patterns that keep UI tests reliable, and how to check the interface by eye in a headless browser.

- [Layers and where tests live](#layers-and-where-tests-live)
- [Unit tests](#unit-tests)
- [Provider tests against MSW](#provider-tests-against-msw)
- [UI tests with `renderApp`](#ui-tests-with-renderapp)
- [Patterns and pitfalls](#patterns-and-pitfalls)
- [Rust tests](#rust-tests)
- [Manual checks in headless Chrome](#manual-checks-in-headless-chrome)
- [CI](#ci)

Setting up a development environment is covered in [development.md](development.md).

## Layers and where tests live

Tests sit next to the code they test: `src/core/intents.ts` is tested in `src/core/intents.test.ts`. Tests that render the whole app live in `src/ui/` and are named after the feature (`src/ui/composer.test.tsx`, `src/ui/allInboxes.test.tsx`).

| Level    | What                                                                                                   | Environment    | Examples                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------- |
| Unit     | Pure logic in `core`, `data`, `state`, `lib`, `i18n`, `keyboard`, `security`, `compose` and UI helpers | Node or jsdom  | `src/core/intents.test.ts`, `src/state/selection.test.ts`, `src/ui/calendar/layout.test.ts`  |
| Provider | Gmail, Microsoft Graph and calendar adapters, their HTTP clients                                       | Node, with MSW | `src/providers/gmail/GmailProvider.test.ts`, `src/providers/microsoft/GraphProvider.test.ts` |
| Auth     | Sign-in sessions, with fakes for Google Identity Services, MSAL and the native bridge                  | Node or jsdom  | `src/auth/google/GoogleAuthSession.test.ts`, `src/auth/native/NativeAuthSession.test.ts`     |
| UI       | The whole app, driven like a user                                                                      | jsdom          | `src/ui/actions.test.tsx`, `src/ui/calendar.test.tsx`                                        |
| Rust     | The desktop app's native side                                                                          | `cargo test`   | `src-tauri/src/vault.rs`, `src-tauri/src/oauth/pkce.rs`                                      |

Vitest is configured in the `test` section of `vite.config.ts`:

```ts
test: {
  environment: "jsdom",
  setupFiles: ["./src/test/setup.ts"],
  restoreMocks: true,
  unstubGlobals: true,
},
```

jsdom is the default; a file opts into Node with a comment (see [Unit tests](#unit-tests)). `restoreMocks` undoes every `vi.spyOn` after each test, and `unstubGlobals` every `vi.stubGlobal`. `src/test/setup.ts` runs before every file: it adds the jest-dom matchers (`toBeInTheDocument`, `toHaveFocus`, …), stubs what jsdom lacks (`scrollIntoView`, `scrollBy`, the `Range` measurements ProseMirror needs, and `URL.createObjectURL`, whose blobs are kept in `objectUrlBlobs` from `src/test/objectUrls.ts`), and after each test unmounts what was rendered, clears localStorage and sessionStorage and resets the URL to `/`.

The helpers in `src/test/`:

| File                 | What it gives you                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `renderApp.tsx`      | `renderApp()`, `demoHash()`, `unifiedHash()`, `TEST_NOW` (see [UI tests](#ui-tests-with-renderapp))                                  |
| `viewport.ts`        | `mockViewport("wide" \| "medium" \| "narrow")`: stubs `matchMedia` for 1400, 800 or 390 px; `narrow` also reports a coarse pointer   |
| `gmailFixtures.ts`   | Gmail API objects: `gmailMessage`, `gmailLabel`, `leafPart`, `multipart`, `base64Url`, `utf8Base64Url`                               |
| `graphServer.ts`     | `FakeGraph`, an in-memory Outlook mailbox behind Microsoft Graph, for MSW                                                            |
| `folderData.ts`      | `createFolderData(now)`: a small Outlook-like account for the in-memory provider, with its ids in `FOLDER`                           |
| `desktopPlatform.ts` | `fakeDesktopPlatform()`: a desktop `Platform` made of spies, with the native side's events fired by hand (options: OS, dictionaries) |
| `memoryStorage.ts`   | `MemoryStorage`, an in-memory `Storage`; `dump()` returns everything stored, for "no secrets here" assertions                        |

Run all tests with `npm test`, keep them running with `npm run test:watch`, or run a single file or test with `npx vitest run src/ui/actions.test.tsx -t "rolls back"`.

## Unit tests

Pure functions are tested directly, without rendering anything: intents and recurrence rules in `src/core`, optimistic updates and the query cache in `src/data`, selection, settings and the router in `src/state`, and layout helpers such as `src/ui/common/toolbarFit.ts` or `src/ui/mailboxes/buildTree.ts`.

A test that needs no DOM starts with a comment that switches it to the Node environment, which is faster and proves the code doesn't touch the DOM. From `src/state/selection.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type MessageKey } from "../core/ids";
import { clearSelection, EMPTY_SELECTION, toggle } from "./selection";
```

`src/test/setup.ts` checks for `window` and `Element` before touching them, so it works in both environments. Tests that need the DOM stay in jsdom, for example DOMPurify in `src/security/sanitize.test.ts`, keyboard events in `src/keyboard/registry.test.ts`, or data hooks rendered with `renderHook` in `src/data/searchLists.test.tsx`.

Code that waits or reads the clock takes it as an option, so tests don't have to wait: `GmailHttp` takes `sleep` and `random` (backoff and its jitter), `GraphProvider` and the demo module take `now`. Where real timers are involved, unit tests use `vi.useFakeTimers()` and `vi.advanceTimersByTime(…)` (the sequence timeout in `src/keyboard/registry.test.ts`), and switch back with `vi.useRealTimers()` in `afterEach`. Code that keeps settings or tokens gets a `MemoryStorage`.

## Provider tests against MSW

The Gmail and Microsoft adapters are tested against [MSW](https://mswjs.io/), which answers `fetch` calls with handlers defined in the test. Every file that uses MSW sets up the server the same way, so a request without a handler fails the test:

```ts
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
```

These files run in the Node environment (`// @vitest-environment node`). The provider gets a `StaticAuthSession` (`src/auth/staticSession.ts`) instead of a real sign-in, and a `sleep` that returns at once, so retries don't wait:

```ts
const provider = () =>
  new GmailProvider(
    new GmailHttp({
      auth: new StaticAuthSession(),
      sleep: () => Promise.resolve(),
    }),
  );
```

**Gmail.** Each test adds the handlers it needs with `server.use(http.get(url("labels"), …))` and builds Gmail's JSON with the fixtures in `src/test/gmailFixtures.ts`: `gmailMessage(id, { labelIds, headers, payload })` gives a message with sensible defaults, `leafPart` and `multipart` build MIME trees, and `utf8Base64Url` encodes bodies the way Gmail does. Handlers can record what they received (search parameters, bodies) for assertions. The HTTP client's retries, backoff and token handling are tested in `src/providers/gmail/http.test.ts`, the Google Calendar adapter in `src/providers/gmail/calendar.test.ts`.

**Microsoft Graph.** Graph is stateful enough that a fake mailbox is simpler than handlers per test. `FakeGraph` (`src/test/graphServer.ts`) keeps folders (Inbox, Drafts, Sent Items, Deleted Items, Junk Email, Archive, Outbox, Conversation History, and Projects with a Clients subfolder; the system folders also answer to their well-known names), messages, attachments, drafts, upload sessions, categories, people and `me`, and answers `$batch` and delta queries. It answers what `GraphProvider` asks, not all of Graph.

```ts
function setup(options: { personal?: boolean } = {}) {
  const graph = new FakeGraph();
  server.use(...graph.handlers());
  // … a GraphProvider with a StaticAuthSession, a MemoryStorage and a fixed `now`
}
```

- `graph.add({ id: "a", isRead: false }, "inbox")` puts a received message into a folder (by id or well-known name).
- `graph.change(id, patch)` and `graph.remove(id)` change the mailbox as if from another device; delta queries report it. `graph.addFolder(…)` does the same for folders.
- `graph.requests(method, pathPattern)` returns the requests answered so far, each with its path below `v1.0/`, query, body, whether it was batched and its `Prefer` header; `graph.seen` has all of them. For example `graph.requests("GET", /^me\/messages$/)[0]?.query.get("$filter")`.
- `graph.failures` injects errors: the next request with that method and path gets the status, once.

  ```ts
  graph.failures.set("GET me/people", 403);
  ```

The Graph calendar adapter (`src/providers/microsoft/calendar.test.ts`) uses handlers per test, like Gmail.

**Other adapters.** The iCal provider takes a `fetch` option, so its test passes a `vi.fn<typeof fetch>()` instead of using MSW (`src/providers/ical/IcsCalendarProvider.test.ts`). The sign-in sessions are tested against scriptable fakes of `google.accounts.oauth2` and of the MSAL client (`src/auth/google/GoogleAuthSession.test.ts`, `src/auth/microsoft/MicrosoftAuthSession.test.ts`), and the desktop bridge against a fake `invoke` (`src/platform/native/*.test.ts`). The in-memory provider used by the demo and the UI tests has its own tests in `src/providers/fake/`.

## UI tests with `renderApp`

UI tests render the whole `<App>` against the in-memory demo provider and drive it like a user. `renderApp()` (`src/test/renderApp.tsx`) does the wiring:

```ts
const { user, services } = renderApp();
await screen.findByRole("heading", { level: 1, name: "Welcome to the demo" });
await user.keyboard("a");
```

It returns Testing Library's render result plus `services` (the `AppServices`: account registry, query client, UI store, router, command registry, …) and `user`, a `userEvent.setup()` instance. Its options:

| Option            | Default                        | What it does                                                                                                                            |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `viewport`        | `"wide"`                       | `"wide"`, `"medium"` or `"narrow"` (1400, 800, 390 px), through `mockViewport`                                                          |
| `signedIn`        | `true`                         | Stores the demo account in the account list first, as if restored from an earlier visit                                                 |
| `hash`            | none                           | The URL hash to start at, usually from `demoHash()` or `unifiedHash()`                                                                  |
| `data`            | `createDemoData(TEST_NOW)`     | The first demo account's mail                                                                                                           |
| `workAccount`     | `false`                        | Also the second demo account (Outlook-like folders), as if restored                                                                     |
| `workData`        | `createWorkDemoData(TEST_NOW)` | The second account's mail                                                                                                               |
| `calendar`        | `createDemoCalendar(TEST_NOW)` | The demo calendar, with events in the week of Monday 2026-10-12                                                                         |
| `calendarAccess`  | `"granted"`                    | The calendar's access, as if the account had (not) allowed it yet                                                                       |
| `guestNotices`    | `"ask"`                        | Whether guests hear about changes only when asked (like Google) or always (`"always"`, like Microsoft)                                  |
| `syncedReminders` | `false`                        | The calendar keeps reminder snoozes and dismissals itself, like Outlook                                                                 |
| `reminders`       | `false`                        | Event reminders on. Off by default, so the demo's repeating events can't remind in tests that don't expect it, whatever the time of day |
| `icsFactory`      | the real `IcsCalendarProvider` | Creates the calendars of iCal subscriptions                                                                                             |
| `platform`        | the web app's                  | For example `fakeDesktopPlatform().platform`                                                                                            |
| `setups`          | none                           | Runtime provider setups, for the Add account wizard                                                                                     |
| `modules`         | one demo module                | Replaces the provider modules entirely; `data`, `calendar` and the other demo options then don't apply                                  |

Some things are fixed: the demo module answers without latency (`latencyMs: 0`) and without new mail arriving (`arrivalEveryMs: false`), and the query cache isn't persisted (`sessionStorage: undefined`), so every test starts cold. When the test finishes, the router is disposed and the query cache cleared.

`demoHash(mailboxId, messageId?)` builds the route of a demo mailbox (`#/demo%3Ademo%40example.com/inbox`), `unifiedHash(accountId?, inboxId?, messageId?)` the route of All inboxes (`#/all/…`). `TEST_NOW` is `2026-10-18T12:00:00Z`, the "now" the demo data is built around.

**The in-memory provider.** `FakeMailProvider` (`src/providers/fake/FakeMailProvider.ts`) implements `MailProvider` with Gmail's label semantics, or with Outlook's folders when its data says `folders: true` (`createFolderData` in `src/test/folderData.ts`, or the work demo account). Tests reach it through the registry and flip its switches: `failWrites` makes every write fail (to test rollback), `contactsUnavailable` and `signaturesReadOnly` make contact searches and signature changes fail as `unavailable` (like a disabled People API or a declined permission), and `oneClickRequests` records one-click unsubscribe requests. From `src/ui/actions.test.tsx`:

```ts
it("rolls back and reports a failed write", async () => {
  const { user, services } = renderApp();
  await subject("Welcome to the demo");
  const provider = services.registry.list()[0]?.provider as FakeMailProvider;
  provider.failWrites = true;

  await user.keyboard("a");
  expect(
    await toastText(/Couldn’t archive: The demo server refused the change/),
  ).toBeInTheDocument();
  expect(await option(/Welcome to the demo/)).toBeInTheDocument();
});
```

**The desktop app.** `fakeDesktopPlatform()` (`src/test/desktopPlatform.ts`) returns a desktop `Platform` whose functions are all `vi.fn()` spies, plus `poll()`, `compose(mailto)` and `closeToTray()` to fire what the native side would send. From `src/ui/desktop.test.tsx`:

```ts
const desktop = fakeDesktopPlatform();
renderApp({ platform: desktop.platform });
await subject("Welcome to the demo");
act(() => {
  desktop.compose("mailto:anna@example.org?subject=Lunch%3F");
});
```

**Queries.** Find elements the way a user or a screen reader does: by role and accessible name. The conventions the tests rely on:

- The open message's subject is the `heading` of level 1.
- List rows are `option`s in a `listbox`; the folder tree is a `tree` of `treeitem`s.
- Dialogs are `dialog`s named after their title; the composer is named after its subject.
- Buttons are named by their label with the shortcut, for example `"Archive (a)"`.
- Toasts are found by text: `screen.findByText(text, { selector: "div[aria-live] span" })`.

Use `findBy…` for anything that appears after a provider call (every call is a promise, even without latency) and `queryBy…` to assert that something is gone. Press keys with `await user.keyboard("a")` or `"{Shift>}u{/Shift}"`. To test in German, mock the browser's languages, as `src/ui/german.test.tsx` does:

```ts
vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-AT", "de"]);
```

## Patterns and pitfalls

**jsdom has no layout.** Every size and position is 0, so code that measures (the message list's scroll anchoring, the reader toolbar that moves what doesn't fit into ⋯) needs the measurements mocked. Spy on the getters of `HTMLElement.prototype` and answer per element. From `src/ui/liveUpdates.test.tsx`, where rows are 60 px:

```ts
vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
  function (this: HTMLElement) {
    return this.dataset.rowKey ? 60 : 0;
  },
);
vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
  function (this: HTMLElement) {
    if (!this.dataset.rowKey || !this.parentElement) return 0;
    return Array.from(this.parentElement.children).indexOf(this) * 60;
  },
);
```

jsdom has no `ResizeObserver` either. Code that uses it checks for it first (`OverflowToolbar` then simply shows every button), so tests that don't care see the full toolbar. `src/ui/readerToolbar.test.tsx` mocks `clientWidth` and `offsetWidth` and stubs `ResizeObserver` with `vi.stubGlobal`, keeping the callbacks so the test can "resize" the toolbar:

```ts
const observers: (() => void)[] = [];
vi.stubGlobal(
  "ResizeObserver",
  class {
    readonly #callback: () => void;
    constructor(callback: () => void) {
      this.#callback = callback;
      observers.push(callback);
    }
    observe() {
      this.#callback();
    }
    disconnect() {
      return undefined;
    }
  },
);
```

**Fake timers in UI tests.** Use `vi.useFakeTimers({ shouldAdvanceTime: true })`: the fake clock then also moves with real time, so code that polls or waits on timers (Testing Library's `findBy…` and `waitFor`, user-event) keeps working. Jump ahead inside `act`, and switch back after each test, as `src/ui/reminders.test.tsx` does:

```ts
afterEach(() => {
  vi.useRealTimers();
});
// …
await act(async () => {
  await vi.advanceTimersByTimeAsync(110_000);
});
```

Often an injected clock is simpler. `src/ui/liveUpdates.test.tsx` passes the demo module a `now` that the test moves forward, then fires `online` so the app checks for changes right away instead of waiting a minute.

**Tests that depend on the clock.** The demo data is built around `TEST_NOW`, but the app reads the real clock. Tests about "now" (reminders) therefore build their events from `Date.now()`, and must pass at any second of any day. Commit 30cc105 ("Reminder tests: don't depend on the clock's seconds") is the example to learn from: test events start on a full minute, and rounding the start down made a reminder due "in half a minute" already due whenever the seconds were past 30. Rounding up fixed it, and the assertions accept either neighbouring minute (`/In [56] minutes/`). `renderApp` keeps reminders off by default for the same reason.

**Timeouts.** Vitest gives a test 5 seconds. Files whose tests wait for the composer's autosave (two seconds after the last edit, `AUTOSAVE_DELAY_MS`) or other slow paths raise that at the top, typically to 15 seconds (20 in `src/ui/reminders.test.tsx`):

```ts
// Some tests wait for the composer's autosave.
vi.setConfig({ testTimeout: 15_000 });
```

CI machines are slower than a laptop: commit 424b8c9 added this to `src/ui/allInboxes.test.tsx` after a test that waits for an autosave and then a move took longer than five seconds there. The composer and Settings load on first use (`lazy()`), so tests give their dialogs more than Testing Library's default second to appear: `screen.findByRole("dialog", { name }, { timeout: 5000 })`. Waiting for "Saved" in the composer uses `{ timeout: 4000 }`.

**"Found multiple elements".** `getBy…` and `findBy…` throw when more than one element matches. A message's subject shows both in its list row and in the reader, so the tests pick the role (`option` for the row, `heading` of level 1 for the reader) or narrow the search with `within(…)`. When you add test data, give every message, label and event a subject or name of its own, and avoid names that contain another one when you match with a regular expression.

**Exact texts.** Assertions use the interface's texts as they are, and the catalogue mostly uses typographic apostrophes and quotes (`Couldn’t`, „…“). Copy the text from `src/i18n/texts/` rather than typing it.

**Stored state.** localStorage, sessionStorage and the URL are reset after every test. To start with stored settings, write them before `renderApp`, under `UI_STATE_KEY` with the store's version, as `src/ui/settings.test.tsx` does: `JSON.stringify({ state: { settings }, version: 1 })`.

**Test names** describe behaviour in a plain sentence, and `describe` names the feature: `describe("archive", …)` with `it("rolls back and reports a failed write", …)`.

## Rust tests

The desktop app's native side has unit tests in a `#[cfg(test)] mod tests` at the end of its modules in `src-tauri/src/`. Run them in `src-tauri/`:

```sh
cargo test
```

| Module (`src-tauri/src/`) | What the tests cover                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth/pkce.rs`           | The code challenge matches RFC 7636's example; generated verifiers are valid                                                                                                                              |
| `oauth/providers.rs`      | Building Google's sign-in URL, redeeming codes the way each provider wants, reading who signed in from the ID token, comparing scopes like the providers do                                               |
| `oauth/loopback.rs`       | Parsing the browser's request, accepting only callbacks to its own path, escaping the page text, and a real round trip over a local port (`#[tokio::test]`)                                               |
| `oauth/mod.rs`            | Telling token refusals apart (expired grant, bad client, HTTP errors) and handing errors to the UI with their kind                                                                                        |
| `vault.rs`                | Accounts stay encrypted between starts, nothing is written without a keychain, a different key starts over. They use an in-memory key store and a temporary folder, never the real keychain               |
| `net.rs`                  | Reading the request header, fetching only web addresses (no `file:`), framing the answer                                                                                                                  |
| `shell.rs`                | Finding `mailto:` links among the start arguments                                                                                                                                                         |
| `files.rs`                | Keeping file names inside their folder                                                                                                                                                                    |
| `background.rs`           | The Android background check against a local mock server (`wiremock`): new Gmail mail notified once, Graph's answer, grouping, first sight only counting, nothing while off or without a token, UTC times |

CI runs `cargo clippy --all-targets` too, so the tests are linted like the rest; its `android` job also runs Clippy for an Android target, where the Android-only code is compiled. How the UI uses the native side is tested in TypeScript instead: the bridge in `src/platform/native/*.test.ts` and `src/auth/native/NativeAuthSession.test.ts`, the interface with `fakeDesktopPlatform()` in `src/ui/desktop.test.tsx` and with `fakeAndroidPlatform()` in `src/ui/android.test.tsx`. The Kotlin side has no automated tests: try it on the emulator (`scripts/android-setup.sh --emulator`, then `npm run android:dev`) or a phone, as described in [android.md](android.md#building-running-and-debugging).

## Manual checks in headless Chrome

Automated tests can't see what the interface looks like. Before asking the user to try a feature, it helps to look at it at phone, tablet and desktop widths, in dark mode and in German. The approach:

1. Start the dev server: `npm run dev`.
2. Drive `http://localhost:5173/?demo` with [puppeteer-core](https://pptr.dev/) and the Chrome or Chromium installed on the system.
3. Take screenshots and look at them.

These scripts are not part of the repository, and `puppeteer-core` isn't a dependency. Keep them in a scratch folder outside the project and install `puppeteer-core` there. A starting point:

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable", // your Chrome or Chromium
  headless: true,
});
const sizes = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
  tablet: { width: 800, height: 1100 },
  desktop: { width: 1400, height: 900 },
};
for (const [name, viewport] of Object.entries(sizes)) {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: scheme },
    ]);
    await page.goto("http://localhost:5173/?demo");
    await page.waitForSelector('[role="option"]');
    await page.screenshot({ path: `${name}-${scheme}.png` });
    await page.close();
  }
}
await browser.close();
```

Some hints:

- The widths match the app's breakpoints (`src/ui/layout/useBreakpoint.ts`: 640 and 1024 px) and the test viewports: 390 shows one pane at a time, 800 the drawer layout, 1400 three columns.
- The theme follows the system unless one was chosen, so emulating `prefers-color-scheme` switches it. Setting `a0.theme` to `dark` in localStorage does the same.
- For German, override the browser's languages before the app loads; the app picks German when the first one is German, and `de-AT` also gives Austrian dates:

  ```js
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "languages", {
      get: () => ["de-AT", "de"],
    });
  });
  ```

- Navigate with the keyboard (`page.keyboard.press("j")`), clicks, or by going to a hash route. On phones the panes follow the URL hash, so `page.goBack()` checks the back button too.
- The demo's new mail arrives every two minutes, so screenshots taken later can differ.

The headless browser doesn't replace a real device. Sign-in with Google or Microsoft, real touch gestures (long press, dragging), notifications and the desktop app have to be tried by hand; say so in the test checklist (see [Workflow](development.md#workflow)).

## CI

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`. A newer run for the same ref (branch or pull request) cancels the one in progress. Its single job, `check`, runs on `ubuntu-latest` with a 30-minute limit:

1. Check out, set up Node from `.nvmrc` (with npm's cache), `npm ci`.
2. `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`.
3. Install the desktop app's Linux libraries (`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, `libssl-dev`) and the stable Rust toolchain with `clippy` and `rustfmt`, with a Rust build cache.
4. In `src-tauri/`: `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`. The Rust build embeds `dist/`, which the build step made.

A second job, `android`, lints the Rust side for `aarch64-linux-android` and builds a debug APK (which compiles the Kotlin side). It isn't a required check.

`main` is protected, and `check` is its required status check: a pull request can't be merged until it passes. To reproduce CI locally:

```sh
npm ci
npm run check
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

`npm run check` runs the Node steps in CI's order, and its build creates the `dist/` the Rust steps need. A format failure is fixed with `npm run format` (it covers Markdown too) or `cargo fmt`. A UI test that passes locally but times out on CI usually needs one of the fixes under [Patterns and pitfalls](#patterns-and-pitfalls).

Release builds run in a separate workflow, `.github/workflows/release.yml`; see [releasing.md](releasing.md).
