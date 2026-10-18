# action0 mail

A fast, keyboard-first mail client that runs entirely in the browser. It is a static web app with no backend: it signs in with OAuth in the browser and talks to the mail provider's REST API directly.

**Status:** Gmail: reading, archive, read/unread, move, labels, stars, Trash and Spam, search, writing, attachments, live updates (features 1–8).

- Three columns: accounts and folders, message list, message. On tablets the folders move into a drawer; on phones you see one pane at a time and the back button works.
- Several Gmail accounts side by side.
- New mail and changes made elsewhere (on your phone, in Gmail web) show up by themselves: every minute while the app is in front, every five minutes in the background, and right away when you come back to the tab. The tab title shows the unread count of all inboxes, and desktop notifications (if you turn them on) tell you about new Inbox mail while you're in another tab or app. Phones only allow notifications for installed apps, so they aren't offered there yet.
- Archive, mark as read/unread, star, move, label, trash and report spam, for one message or a whole selection. Changes show up instantly and can be undone (<kbd>z</kbd>).
- Permanent deletion ("Delete forever", "Empty Trash/Spam") inside Trash and Spam, always with a confirmation.
- Drag messages onto a label in the folder tree to move them there; hold <kbd>Ctrl</kbd> (or <kbd>Alt</kbd>/<kbd>Option</kbd> on a Mac) to only add the label. On touch screens, use **Move to…** and **Labels…** in the selection bar instead.
- Write, reply, reply all and forward in a composer docked at the bottom right (full screen on phones). Basic formatting, address suggestions from your Google contacts, drafts that save themselves, and 30 seconds to take a sent mail back.
- Attachments: pictures open in a viewer (<kbd>←</kbd>/<kbd>→</kbd>, <kbd>Esc</kbd>), PDFs in the browser's PDF viewer, everything else downloads. HTML and other files that could run code are never opened inside the app. Attach files with the paperclip, by dragging them onto the composer (or anywhere, to start a new mail) or by pasting; pictures dropped or pasted into the text appear inline. Up to 25 MB per mail.
- Search as you type, in the current folder or everywhere. Gmail's search operators work (`from:`, `has:attachment`, `before:2026/01/01`, …). The search is part of the URL, so Back and reloading keep it.
- Sort the list by date, newest or oldest first.
- Filter the folder tree by name, to find a label quickly.
- Keyboard shortcuts for everything (press <kbd>?</kbd> in the app).
- Safe HTML mail: sanitized, rendered in a sandboxed iframe without scripts, remote images blocked until you allow them.
- A demo account with sample mail, so you can try the UI without signing in.

## Quick start

Requires Node.js 22.12 or newer (CI uses the version in `.nvmrc`).

```sh
npm install
npm run dev
```

Open <http://localhost:5173/?demo> to start with the demo account. To read your Gmail, set up an OAuth client first (next section).

## Setting up Google sign-in

The app uses the Google Identity Services token model with the full-access scope `https://mail.google.com/`. Everything except permanent deletion would work with the narrower `gmail.modify`; "Delete forever" and "Empty Trash" need full access. For address suggestions it also asks for read access to your contacts (`contacts.readonly`, `contacts.other.readonly`); that part is optional. You need your own OAuth client ID; it is not a secret and is embedded in the built app.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project (or pick an existing one).
2. Go to **APIs & Services → Library**, search for **Gmail API** and enable it. Do the same for the **People API** (address suggestions from your contacts).
3. Go to **Google Auth Platform** (formerly _OAuth consent screen_) and configure it:
   - **Branding:** an app name and your support email.
   - **Audience:** choose **Internal** if you only use accounts of your own Google Workspace organization. Otherwise choose **External**, keep the publishing status at **Testing**, and add every Gmail address you want to use under **Test users**.
   - **Data access:** add the scopes `https://mail.google.com/`, `https://www.googleapis.com/auth/contacts.readonly` and `https://www.googleapis.com/auth/contacts.other.readonly`. If you set the app up earlier with fewer scopes, add the missing ones; each account then reconnects once.
4. Go to **Clients → Create client**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins:** `http://localhost:5173` (used by both `npm run dev` and `npm run preview`). Add the URL of any deployment later.
   - **Authorized redirect URIs:** none needed.
5. Copy the client ID and give it to the app, either way works:
   - **In the app:** **Add account → Google** shows these steps (with the exact origin to copy) and a field for the client ID. It's saved as a setting in that browser. This also works on a deployed site, without a rebuild.
   - **In `.env.local`** in the project root; this takes precedence over the setting in the browser:

     ```sh
     cp .env.example .env.local
     # then edit .env.local:
     VITE_GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
     ```

6. **Add account → Google → Continue with Google**, choose your account and allow access.

Things to know:

- `https://mail.google.com/` is a _restricted_ scope. In **Testing** mode (or with an **Internal** app) that's fine for you and your test users; Google shows a "Google hasn't verified this app" warning that you can continue past. Publishing the app for everyone would require Google's verification and a security assessment.
- Google issues access tokens that last **one hour** and no refresh token to browser apps without a backend. The app refreshes the token on your next click or key press shortly before it expires (the Google popup opens and closes by itself while you're signed in to Google). If that's not possible, a bar offers a one-click **Reconnect**. On touch devices the popup would open as a new tab, so there the bar appears a few minutes before expiry instead.
- Live updates need a valid Google token too. If the tab sits unused for more than an hour, the token can't be renewed without a click, so updates and notifications pause; the tab title then says "Reconnect".
- A message counts as read once it has been on screen for 1.5 seconds, so skimming through the list with <kbd>j</kbd>/<kbd>k</kbd> doesn't mark everything read.

### Troubleshooting Google sign-in

Google shows these errors in its own window, so the app can't see them; the wizard lists them under _Did Google show an error?_.

| Google says                                                             | Fix                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Error 401: invalid_client**, _no registered origin_                   | The client has no **Authorized JavaScript origin** for the address you opened (or isn't of type _Web application_). Add exactly `http://localhost:5173`: `http`, no trailing slash, `localhost` rather than `127.0.0.1`. Redirect URIs stay empty. Changes take a few minutes. |
| **Error 400: origin_mismatch**                                          | Same cause: the address in the browser isn't one of the registered origins.                                                                                                                                                                                                    |
| **Access blocked: … has not completed the Google verification process** | Your address isn't a test user. Add it under **Audience → Test users**.                                                                                                                                                                                                        |
| A message about your **organization** or **administrator**              | Your Google Workspace admin blocks unverified apps. Only they can allow it.                                                                                                                                                                                                    |
| The popup doesn't open                                                  | The browser blocked it. Allow popups for the site and click again.                                                                                                                                                                                                             |
| Address suggestions only come from recent mail                          | The composer says why: either the **People API** isn't enabled in your Google Cloud project (enable it, wait a few minutes), or contacts access was declined in the Google window (sign out and add the account again to be asked once more).                                  |

## Testing on a phone

`npm run dev:lan` makes the dev server reachable on your local network. The demo works there right away (`http://<your-ip>:5173/?demo`).

Google sign-in does not: Google only allows plain `http://` origins for `localhost`. To sign in from a phone, serve the app over HTTPS, for example through a tunnel, and add that HTTPS origin to the OAuth client's _Authorized JavaScript origins_. Vite only accepts known host names, so also add the tunnel host to `server.allowedHosts` in `vite.config.ts` while testing.

## Scripts

| Command           | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `npm run dev`     | Dev server on <http://localhost:5173>                           |
| `npm run dev:lan` | Same, reachable from other devices on the network               |
| `npm run build`   | Typecheck and production build into `dist/` (with a strict CSP) |
| `npm run preview` | Serve the production build on port 5173                         |
| `npm test`        | Run all tests once (`npm run test:watch` to keep watching)      |
| `npm run lint`    | ESLint (strict, type-aware, accessibility rules)                |
| `npm run format`  | Format everything with Prettier (`format:check` only checks)    |
| `npm run check`   | Everything CI runs: typecheck, lint, format check, tests, build |

## Keyboard shortcuts

| Keys                                                                        | Action                                                    |
| --------------------------------------------------------------------------- | --------------------------------------------------------- |
| <kbd>j</kbd> / <kbd>k</kbd>, <kbd>↓</kbd> / <kbd>↑</kbd>                    | Next / previous message                                   |
| <kbd>Shift</kbd> + <kbd>j</kbd> / <kbd>k</kbd>                              | Extend the selection                                      |
| <kbd>x</kbd>                                                                | Select or unselect the current message                    |
| <kbd>Esc</kbd>                                                              | Clear the selection (phones: back)                        |
| <kbd>Home</kbd> / <kbd>End</kbd>                                            | First / last loaded message                               |
| <kbd>Space</kbd> / <kbd>Shift</kbd> + <kbd>Space</kbd>                      | Scroll the message                                        |
| <kbd>g</kbd> then <kbd>i</kbd> / <kbd>s</kbd> / <kbd>d</kbd> / <kbd>a</kbd> | Go to Inbox / Sent / Drafts / All Mail                    |
| <kbd>/</kbd>                                                                | Search mail (Enter or ↓: to the results, Esc: end search) |
| <kbd>g</kbd> then <kbd>f</kbd>                                              | Filter folders (Enter opens the first match)              |
| <kbd>c</kbd>                                                                | Write a new mail                                          |
| <kbd>r</kbd> / <kbd>Shift</kbd> + <kbd>r</kbd> / <kbd>f</kbd>               | Reply / reply all / forward                               |
| <kbd>Ctrl</kbd> + <kbd>Enter</kbd> (Mac: <kbd>⌘</kbd> + <kbd>Enter</kbd>)   | Send (in the composer; <kbd>z</kbd> takes it back)        |
| <kbd>Esc</kbd> in the composer                                              | Close it; the draft is kept                               |
| <kbd>a</kbd>                                                                | Archive the message or selection                          |
| <kbd>Shift</kbd> + <kbd>i</kbd> / <kbd>u</kbd>                              | Mark as read / unread                                     |
| <kbd>z</kbd>                                                                | Undo the last action                                      |
| <kbd>v</kbd>                                                                | Move to… (pick a mailbox, Enter moves)                    |
| <kbd>l</kbd>                                                                | Labels… (toggle labels, Enter applies, Esc cancels)       |
| <kbd>s</kbd>                                                                | Star / unstar                                             |
| <kbd>Delete</kbd> (Mac: <kbd>⌫</kbd>)                                       | Move to Trash; inside Trash: restore                      |
| <kbd>Shift</kbd> + <kbd>s</kbd>                                             | Report spam; inside Spam: not spam                        |
| <kbd>Shift</kbd> + <kbd>Delete</kbd>                                        | Delete forever (inside Trash and Spam, with confirmation) |
| <kbd>Enter</kbd> or <kbd>o</kbd>                                            | Open the message (phones)                                 |
| <kbd>?</kbd>                                                                | Show all shortcuts                                        |

With the mouse: click shows a message, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>-click toggles, <kbd>Shift</kbd>-click selects a range. On touch screens, a long press starts selecting.

## Architecture

```
src/
  core/        Domain model, MailProvider interface, errors, reply rules. No dependencies.
  auth/        AuthSession interface; google/ = Google Identity Services token client
  providers/
    gmail/     Gmail REST adapter: HTTP client (retries, concurrency limit),
               label mapping, MIME parsing, mappers, drafts, People API
    mime/      Builds outgoing MIME messages (shared by raw-message adapters)
    fake/      In-memory provider: tests and the demo account
  accounts/    Account registry: one auth session + provider per account
  data/        Server-state cache (TanStack Query): query keys, hooks, persistence policy;
               draft saving and sending
  compose/     Outgoing mail HTML: quoting, plain-text version, composer content
  state/       UI state (Zustand): focus, selection, layout; hash router
  keyboard/    Central shortcut registry
  security/    HTML sanitizing (DOMPurify) and the mail iframe document (CSP)
  ui/          React components: layout, mailboxes, messages, reader, composer, help
  app/         Composition root: wires providers, registry, cache and UI together
```

Rules, enforced by ESLint where possible:

- The UI, data and state layers depend only on the provider-agnostic contracts in `src/core`. Concrete providers are wired up in `src/app`.
- Providers do no caching; the data layer does.
- IDs and pagination cursors are opaque strings that only their provider interprets.

### Labels and folders

The domain model follows [JMAP (RFC 8621)](https://www.rfc-editor.org/rfc/rfc8621): a message belongs to a _set_ of mailboxes. Each mailbox has a kind:

- `label` — non-exclusive (Gmail labels),
- `folder` — exclusive, one per message (Exchange, IMAP),
- `view` — computed, like Gmail's "All Mail" or "Starred".

An optional role (`inbox`, `sent`, `drafts`, `trash`, `junk`, `archive`, `all`, `flagged`, `important`) lets the UI treat special mailboxes the same way for every provider. Read/unread and starred are flags, not mailboxes. Write operations are _intents_ (`src/core/intents.ts`) such as _archive_ or _set flags_ that each provider translates into its own API calls: in Gmail, archive removes the `INBOX` label; a folder-based provider will move the message to its archive folder. The data layer applies intents optimistically to the cache and rolls them back if the provider refuses. Mailboxes say whether users may move messages in and out (`assignable`): Inbox and your labels are, Sent, Drafts and computed views are not.

### What is stored where

| Where          | What                                                                                                                                                                                                                           | How long                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Memory         | Message bodies, inline images, which messages may load remote images; what you're writing and its files (they save to the account's Drafts, never to browser storage); opened attachments (a few minutes); contact suggestions | Until reload                        |
| sessionStorage | OAuth access tokens; mailbox lists and message list pages (cache; search results stay in memory)                                                                                                                               | Tab session, ≤ 10 min for the cache |
| localStorage   | Account list (provider + email address), column widths, tree expansion, sort order                                                                                                                                             | Until sign-out                      |

Tokens never go to localStorage, and mail content is never stored long-term.

### Security model for HTML mail

1. **DOMPurify** removes scripts, event handlers, `javascript:` URLs, forms, frames and `<meta>`/`<base>` tags.
2. The mail is shown in an **iframe sandbox without `allow-scripts`** (`allow-same-origin` is only there so the app can measure the content's height, which is safe without scripts).
3. A **Content Security Policy inside the iframe** (`default-src 'none'`) blocks every remote request — images, CSS backgrounds and imports, fonts — until you click _Load images_, which allows remote images for that message only. Inline (`cid:`) images are embedded as `data:` URLs.

The production build also sets a strict CSP for the app itself.

## Tests and CI

Tests use Vitest and React Testing Library and live next to the code (`*.test.ts(x)`). Provider APIs are always mocked: the Gmail adapter is tested against [MSW](https://mswjs.io/) HTTP mocks (unhandled requests fail the test), the UI against the in-memory provider.

GitHub Actions runs typecheck, lint, format check, tests and build on every pull request and push to `main` (`.github/workflows/ci.yml`). To make these checks mandatory for merging, add the **check** job as a required status check in the repository's branch protection rules.
