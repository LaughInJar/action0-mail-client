# action0 mail client

A mail client built as a purely static web app (HTML, TypeScript, CSS) with no backend. It authenticates with OAuth in the browser and calls the provider's REST API directly. It exists because the Gmail web UI is a poor user experience, so UX quality is the point of the project.

## How we work (mandatory)

Every feature goes through these steps, one feature at a time. Never skip or merge steps.

1. **Plan**: discuss and plan the feature with the user. Wait for explicit approval.
2. **Code outline**: show the planned code changes, as a diff or a detailed outline with comments. Discuss, then wait for explicit approval.
3. **Implement**: build it, then ask the user to try it and wait until they confirm it works.
4. **Commit and push**: only after step 3 is confirmed. Work happens on a feature branch; push it and open a pull request. `main` is protected: CI (the `check` job) must pass, and the user merges.

Whenever a decision is needed from the user, offer multiple-choice options (AskUserQuestion) with the recommended option first. Never make the user type out an answer.

Once a decision is approved, record it under "Decisions log" below so it persists across sessions.

## Roadmap

1. Gmail, read-only: Gmail REST API, `gmail.readonly` scope, Google Identity Services (GIS) token model.
2. Gmail features added one at a time: archive, move/label, compose, reply, search, and so on.
3. Exchange Online through Microsoft Graph: MSAL.js, SPA auth code flow with PKCE.
4. Possibly IMAP/SMTP. Browsers can't open raw TCP connections, so this needs a small proxy. Don't build it yet, but keep the provider abstraction ready for a proxy-backed adapter that can be added without restructuring.

## Architecture rules

- Each concern has a clear boundary: auth, provider/API access, caching, state, UI. They connect only through TypeScript interfaces. Keep it modular.
- The UI depends only on the provider-agnostic `MailProvider` interface and the domain model, never on Gmail, Graph or IMAP types. Gmail is the first implementation.
- The domain model must support both Gmail labels (a message can have several) and the folder model of Exchange/IMAP. See the decisions log for the agreed model.
- Provider IDs and pagination cursors are opaque strings. The UI never parses them.
- TypeScript strict mode. React + Tailwind, built with Vite.

## Security and storage rules

- Browser storage is only for settings, UI state and short-lived caches with a TTL. Never persist mail content long-term.
- OAuth tokens live in memory or sessionStorage, **never** in localStorage.
- HTML mail is sanitized (DOMPurify) and rendered in a sandboxed iframe. Remote images, and any other remote content, are blocked by default.

## UX principles

- Three-column layout: (a) accounts and folder tree, (b) message list of the selected folder, (c) selected message.
- Responsive, and it must work on mobile. On narrow screens the columns collapse:
  - the tree becomes a drawer
  - on phones, one pane is shown at a time, navigated through the URL hash so the back button works
  - every interaction must also work by touch: no hover-only controls, touch targets at least 44px, and a touch alternative to drag and drop
- Never force unnecessary clicks.
- Drag and drop moves messages into folders or labels.
- Keyboard shortcuts everywhere. For example, `a` archives the current message or the selection. The list supports multi-select.
- Undo wherever possible: every action that changes mail gets an optimistic update, an undo toast and `z`. If an action can't be undone (e.g. permanent deletion), it asks for confirmation instead.

## Quality rules

- TSDoc for public interfaces. The README covers setup, including creating the Google Cloud OAuth client.
- Tests use Vitest + React Testing Library. Provider APIs are always mocked; tests never hit real APIs.
- ESLint (strict) and Prettier for deterministic formatting.
- GitHub Actions CI requires tests, lint and format checks to pass on PRs.

## Commands

- `npm run dev`: dev server on http://localhost:5173 (port is fixed: it is the OAuth origin). Demo: `/?demo`.
- `npm run check`: everything CI runs (typecheck, lint, format check, tests, build). Run it before handing work over.
- `npm test`, `npm run lint`, `npm run format`: individual steps.

## Code conventions

- Module layout and import rules: see README "Architecture". ESLint enforces that `ui/`, `data/`, `state/` and `keyboard/` never import `providers/` or `auth/google/`.
- Tests sit next to the code (`*.test.ts(x)`). Helpers live in `src/test/`. Gmail tests run in the Node environment against MSW (`onUnhandledFrame: "error"`); UI tests render the whole app with `renderApp()` and the in-memory provider.
- Interfaces that get passed around as functions (subscribe, store actions, router) use function-typed properties, not method syntax (`@typescript-eslint/unbound-method`).

## Decisions log

_Approved decisions go here, newest last, one line each with a short rationale._

- **Mailbox model, JMAP-style (RFC 8621):** a message has a set of `mailboxIds`. Each `Mailbox` has `kind: 'folder' | 'label' | 'view'` (folder = exclusive, label = non-exclusive, view = virtual/query-backed, never a drop target), an optional `role` (inbox, sent, drafts, trash, junk, archive, all, flagged) and a `parentId`. Read/unread and starred are flags (`seen`, `flagged`), not mailboxes. Write operations are intents (archive, move, add label, delete) that each provider translates, gated by provider capabilities. Rationale: the one model fits Gmail, Exchange and IMAP without provider branches in the UI.
- **Message list granularity:** one row per message, not per conversation. Rationale: same behavior for every provider. Conversation grouping may come later as an option.
- **Data layer:** TanStack Query for server state (cache, TTL, revalidation, sessionStorage persistence, later optimistic mutations); Zustand for UI state. The provider layer itself does no caching.
- **Accounts:** multi-account support (several Gmail accounts) from feature 1 on.
- **Feature 1 plan approved** (scaffolding + Gmail sign-in + read-only three-column view):
  - Tokens go in sessionStorage. The GIS token is refreshed on user interaction near expiry, with a "Reconnect" bar as fallback.
  - The account list (provider + email, used as login hint) goes in localStorage.
  - Opening a folder shows the newest message immediately.
  - URL-hash routing (account/mailbox/message).
  - Demo mode backed by the fake provider.
  - Remote content is blocked by a CSP `<meta>` inside the sandboxed iframe, on top of DOMPurify.
  - Package manager: npm.
- **Responsive/mobile in feature 1:** the full responsive shell is part of feature 1. Rationale: building the layout shell once is cheaper than reworking it later.
  - Breakpoints: three resizable columns at ≥1024px; tree as a slide-over drawer with list + reader at 640–1024px; one pane at a time below 640px.
  - Panes are driven by the URL hash, so the back button goes reader → list → tree.
  - Touch: tap opens a message, long-press starts multi-select, targets are ≥44px, nothing depends on hover. Phones get a "Move to…" sheet instead of drag and drop when moving arrives.
  - Mail iframe gets a viewport meta tag; wide mails scroll or scale inside the frame, never the page.
  - `dvh` units and safe-area insets.
  - A PWA is a possible separate feature later.
- **Tooling versions:** TypeScript 6.0.x, not 7, because typescript-eslint only supports versions below 6.1. Upgrade once it supports 7. ESLint 10 with eslint-plugin-jsx-a11y; an npm `overrides` entry accepts jsx-a11y's outdated peer range (it was verified to work on ESLint 10). Remove the override once jsx-a11y declares ESLint 10 support. ESLint 9 is end of life.
- **Go-to shortcuts:** `g` then the first letter of the mailbox (`g i`, `g s`, `g d`, `g a` for All Mail). `a` on its own is reserved for archive. Rationale: one consistent scheme; sequences don't collide with single keys.
- **Branch workflow:** `main` is protected (required CI check `check`, changes only via pull requests, admins included). Each feature gets its own branch and PR; the user merges after CI passes. The very first commit went to `main` directly to bootstrap the repo.
- **Feature 2 (archive + read/unread) decisions:**
  - Gmail accounts switch to the `gmail.modify` scope; read-only tokens trigger a one-click reconnect.
  - Opening a message marks it read after it has been on screen for 1.5 s.
  - After archiving, the cursor moves to the next message below, or the one above at the end of the list.
  - Shortcuts: `a` archive, `Shift+I` mark read, `Shift+U` mark unread, `z` undo.
  - Write operations are optimistic with rollback, and show an undo toast.
- **Feature 3 (move/label + star) decisions:**
  - A plain drag moves: it removes the current mailbox's label and adds the target. Ctrl/Alt-drag only adds the label. Touch uses the pickers instead of drag and drop.
  - `v` opens the Move to… picker and `l` the Labels picker. Changes in the label picker apply when it closes (Enter or click outside), as one undoable action; Esc cancels.
  - Spam and Trash are not move targets yet. They come with a separate delete/spam feature.
  - Starring is included: `s` and clickable stars.
- **Feature 4 (delete + spam) decisions:**
  - Delete moves to Trash and Shift+S reports spam. Inside Trash and Spam the same key undoes it: Delete restores, Shift+S means "not spam".
  - Trash and Spam become drag and picker targets. Trashed or spam messages appear in no other list.
  - Permanent deletion is included: "Delete forever" (Shift+Delete, in Trash and Spam only) and "Empty Trash/Spam". It always asks for confirmation, with Cancel as the default button. This needs the full-access scope `https://mail.google.com/`, so accounts reconnect once.
