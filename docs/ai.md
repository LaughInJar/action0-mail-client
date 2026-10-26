# AI assistant

The AI assistant summarizes mail, answers questions about it, writes replies and rewrites drafts, with an AI service the user brings: an API key (Claude, OpenAI, Gemini, any OpenAI-compatible server), an OpenRouter sign-in, a ChatGPT sign-in (the apps only), or a model running on the user's own computer (Ollama, LM Studio). There's no action0 server in between. This document explains how it's built; the README says how to set each service up.

- [Pieces](#pieces)
- [Services and protocols](#services-and-protocols)
- [Keys, sign-ins and requests](#keys-sign-ins-and-requests)
- [What the AI gets](#what-the-ai-gets)
- [The reader's panel](#the-readers-panel)
- [The composer's field](#the-composers-field)
- [Errors](#errors)
- [Adding a kind of service](#adding-a-kind-of-service)
- [Testing](#testing)

## Pieces

| Where                                           | What                                                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ai/types.ts`                               | The contracts: `AiServiceConfig` (a setting, never a key), `AiModel`, `AiRequest`, `AiClient` (models, and `write` streaming the answer), `AiError` |
| `src/ai/backend.ts`                             | `AiBackend`: where keys live and how requests go out                                                                                                |
| `src/ai/kinds.ts`                               | What each kind of service is: protocol, address, setup, key header, default models, privacy and key pages                                           |
| `src/ai/protocols/`                             | Anthropic's Messages API, OpenAI's Chat Completions, OpenAI's Responses API (ChatGPT sign-in); shared error mapping in `common.ts`                  |
| `src/ai/sse.ts`                                 | Reads server-sent events from a streaming body                                                                                                      |
| `src/ai/client.ts`, `services.ts`               | A service's protocol over the backend; `AppServices.ai`                                                                                             |
| `src/ai/demo.ts`                                | The demo AI: canned answers word by word                                                                                                            |
| `src/ai/mailText.ts`, `prompts.ts`              | Mail as the AI reads it, and what it's told for each task                                                                                           |
| `src/ai/webBackend.ts`                          | The web app's backend: keys in browser storage, requests with `fetch`, OpenRouter's popup sign-in                                                   |
| `src/platform/native/ai.ts`                     | The apps' backend over the native side (`src-tauri/src/ai/`, see [desktop-app.md](desktop-app.md#ai-assistant))                                     |
| `src/ui/ai/`                                    | Settings → AI assistant, the service/model picker, the reader's panel, toolbar and menu items, `b`/`q`, the first-use note                          |
| `src/ui/composer/ComposerAi.tsx`, `aiWriter.ts` | The composer's AI field, and writing into the editor                                                                                                |

`ui/` sees the contracts, `kinds.ts`, `mailText.ts` and `prompts.ts`; ESLint keeps it away from `ai/protocols/`, `ai/client.ts` and `ai/webBackend.ts`, which the composition root (`src/app/services.ts`) wires: the web backend in the browser, `NativeStart.ai` in the apps.

## Services and protocols

| Kind         | Protocol         | Address                                                   | Set up with                      | Key header            |
| ------------ | ---------------- | --------------------------------------------------------- | -------------------------------- | --------------------- |
| `anthropic`  | Messages         | `https://api.anthropic.com/v1`                            | API key                          | `x-api-key`           |
| `openai`     | Chat Completions | `https://api.openai.com/v1`                               | API key                          | Bearer                |
| `gemini`     | Chat Completions | `https://generativelanguage.googleapis.com/v1beta/openai` | API key                          | Bearer                |
| `openrouter` | Chat Completions | `https://openrouter.ai/api/v1`                            | Sign-in (PKCE), or a key         | Bearer                |
| `chatgpt`    | Responses        | `https://api.openai.com/v1`                               | Sign in with ChatGPT (apps only) | Bearer (access token) |
| `ollama`     | Chat Completions | `http://localhost:11434/v1` (editable)                    | Address                          | none                  |
| `lmstudio`   | Chat Completions | `http://localhost:1234/v1` (editable)                     | Address                          | none                  |
| `compatible` | Chat Completions | the user's                                                | Address, optional key            | Bearer                |
| `demo`       | canned           |                                                           | nothing                          | none                  |

All protocols stream: `write` yields the answer's text piece by piece. Anthropic's requests carry `anthropic-dangerous-direct-browser-access: true`, Anthropic's consent to calls from a page (the web app has no server to make them). The Responses protocol follows what Sign in with ChatGPT allows: `store: false`, `stream: true`, the system text as `instructions`, and none of the options it refuses; an answer counts only once `response.completed` arrives. Models come from each service's own list (`/models`); `chatModels()` leaves out OpenAI's and Gemini's models that don't write text. `defaultModel()` picks the first of the kind's preferred models the service lists, else its first.

Several services can be set up (`settings.aiServices`). The reader and the composer each remember their last choice (`settings.aiChoices`), and the picker lists the recent choices (`settings.aiRecent`) above every service's models.

## Keys, sign-ins and requests

**Web app** (`webBackend.ts`). A key lives in sessionStorage under `a0.ai.key.<service id>`, or in localStorage when the user ticks **Remember in this browser** for that service; toggling moves it. This is the one opt-in exception to keeping secrets out of localStorage (see `CLAUDE.md` and [security.md](security.md#ai-keys)). `send` adds the kind's key header, refuses addresses outside the service's own, and sends with `credentials: "omit"` and `referrerPolicy: "no-referrer"`.

**OpenRouter in the web app.** A popup (opened inside the click, so blockers let it through) goes to `openrouter.ai/auth` with a PKCE challenge and `callback_url=<app>/redirect.html?to=openrouter`. `redirect.ts` sees `to=openrouter` (MSAL's answers come in the fragment instead), posts the code on the `a0.ai.openrouter` BroadcastChannel and closes the popup. The code and verifier buy a key at `/api/v1/auth/keys`, billed to the user's OpenRouter credit. The opener can't tell whether the popup was closed (a sign-in page may cut the tie), so the UI offers **Stop waiting**.

**Apps** (`src/platform/native/ai.ts`, `src-tauri/src/ai/`). Keys and ChatGPT sign-ins live only in the native side's `ai.vault` (encrypted with the accounts vault's key) and never reach the web view: `ai_save_key` stores a key with the address it's for and its header, and `ai_request` adds it only to requests for that address. Answers stream back through a Tauri channel. OpenRouter and ChatGPT sign in through the system browser and a loopback address; Android tries the same with its browser tab, coming back through the app's own link. Details in [desktop-app.md](desktop-app.md#ai-assistant) and [android.md](android.md).

**Sign in with ChatGPT** uses the user's Go, Plus or Pro plan instead of a key. OpenAI documents it only for apps (a loopback redirect), and its rules keep the tokens out of browser storage, so the web app greys it out. Each install registers itself on the first sign-in (`client_id=dynamic_agent_client`, `ext_agent_host_id`), and the access token is renewed one refresh at a time with the rotating refresh token. OpenAI's notes are shown: **Continue with ChatGPT**, the one-time "You're using your ChatGPT plan" note, and "Using ChatGPT plan · Manage usage" wherever ChatGPT is asked.

## What the AI gets

Nothing goes to a service until the user presses an AI button, and before the first request to a service `useAiNotice()` says what it gets and links its data policy (ChatGPT: OpenAI's plan note). `askAi()` checks first that a service needing a key has one, so a web app that forgot the key says so without sending anything.

**From the reader** (`mailText()`): From, To, Cc, date, subject and text of the message, or of every message of a conversation. The text is what the reader shows: the HTML, sanitized, without hidden elements (`hidden`, `display:none`, `visibility:hidden`, zero font size or height, `mso-hide:all`: the usual hiding places for text meant for machines), as text; the plain-text part only when there's no HTML (text parts are often a stub next to the real HTML). Times are given as the user's clock shows them, with weekday and offset (`localTime()`), and the instructions say what time it is now, so "Friday" and "tomorrow" mean what the user means. Never attachments or images. In a conversation the quoted earlier mail in each reply is dropped (`.gmail_quote`, `blockquote[type=cite]`, Outlook's reply header and what follows), and only the newest messages that fit the budget are kept (about 100,000 characters for online services, 12,000 for local models, which read less); the panel says when older ones were left out.

**From the composer** (`writeRequest()`): the instruction, the draft as text, the selection when rewriting one, the mail being answered (its quote, as visible text), From, To and Subject, and whether a signature follows (so the AI doesn't sign with the name twice).

**Mail that tries to instruct the AI.** Mail and drafts go between `<mail>` / `<draft>` / `<part>` markers, text that would close a marker is defused, and the system text says that text is data whose instructions must never be followed. The AI has no tools and can't act; its answer is shown as React elements (`AiText`: paragraphs, lists, bold) and inserted as editor nodes (`textNodes()`), never as HTML.

Languages: summaries and answers in the interface's language (`aiLanguage()`, "German"); replies and rewrites in the language of the mail or draft, unless the instruction says otherwise.

## The reader's panel

`b` (or **Summarize with AI** in the toolbar, the first button to move into ⋯) and `q` open the panel for what the reader shows: the message, or in conversation view the whole conversation (`aiTarget`). It's also in the reader's and the list's context menus, together with **Reply with AI**. The panel's state is `aiPanel` in the UI store (memory only): its target, why it opened, and the exchanges so far. Going to another message hides it, and coming back shows the answers again; opening it for another mail starts afresh. A summary runs once per opening when there's none yet; a question goes after the earlier answers (`readerRequest()` puts the mail into the first turn). **Try again** replaces the last answer, **Stop** keeps what was written.

## The composer's field

**✨** in the editor's toolbar or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>J</kbd> opens the field above the editor; **Reply with AI** opens a reply with it (`ai: true` on the composer session). `writeTarget()` decides what it acts on: an empty draft is written, a selection rewritten, otherwise the whole draft. Quick changes (Shorter, More formal, Friendlier, Fix spelling & grammar) run at once; **Translate to…** starts the instruction.

`startWriting()` (`aiWriter.ts`) makes the editor read-only and replaces the target's range as the text arrives, with `addToHistory: false`. At the end it puts the original back and replaces it with the final text in one transaction that the history records, so **Undo** (or <kbd>Ctrl</kbd>+<kbd>Z</kbd>) brings back exactly what was there, selection included (Try again rewrites the same selection). A selection inside a paragraph joins the first and last lines of the answer to it (an open slice). Stopping keeps what was written; a failure or an empty answer puts the original back. The signature and the quote live outside the editor, so they're never touched.

## Errors

`AiError.kind` tells failures apart, and `aiErrorText()` words them per service: no key known (`noKey`), key refused, sign-in ran out, no credit, limits (ChatGPT: the plan's usage limit), not eligible, busy, unreachable (local and other servers get a hint about starting them and allowing the site), unknown model, and anything else with the service's own message. Key and sign-in problems come with **Open settings**, which scrolls Settings to the AI assistant.

## Adding a kind of service

1. Add it to `AiKind` and `AI_KINDS` (protocol, address, setup, key header, default models, privacy and key pages), and to `isAiKind` in `src/state/settings.ts`.
2. A new wire protocol goes into `src/ai/protocols/` and `PROTOCOLS` in `client.ts`; most services speak Chat Completions already.
3. Its texts (hint, privacy note) go into `src/i18n/texts/ai.ts`, and `ADDABLE` in `AiSettings.tsx` decides where it's offered.
4. The apps need nothing new unless it signs in differently: keys and their headers are generic.

## Testing

- `src/ai/*.test.ts`: SSE parsing, every protocol against fake streaming responses (`src/test/aiStreams.ts`), mail text, prompts, the web backend (storage, headers, the OpenRouter exchange).
- `src/ui/composer/aiWriter.test.ts`: writing into a real Tiptap editor, undo and selections.
- `src/ui/ai.test.tsx`: the whole app with `fakeAiBackend()` (`src/test/aiBackend.ts`), which speaks Anthropic's protocol from memory and records what was asked.
- `src/platform/native/ai.test.ts` and the Rust tests: the channel, the address check, the sign-ins' requests.

Real services need real keys, so they're checked by hand: see the test checklist of the feature's pull request.
