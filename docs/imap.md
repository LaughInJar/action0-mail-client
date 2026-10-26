# IMAP and SMTP accounts

"Other mail server" accounts work with any provider that offers IMAP and SMTP: GMX, web.de, iCloud, Yahoo, Fastmail, mailbox.org, Posteo, your own server. Browsers can't open IMAP or SMTP connections, so they exist only in the desktop and Android apps, whose native side (Rust) talks to the servers; the web app's wizard shows the card greyed out with "In the desktop and Android apps". There's no proxy and no mail on disk: everything loads from the server and is cached in memory, like the other account types.

- [Pieces](#pieces)
- [Adding an account](#adding-an-account)
- [Certificates and TLS](#certificates-and-tls)
- [Yahoo and AOL sign-in](#yahoo-and-aol-sign-in)
- [The mail model](#the-mail-model)
- [New mail](#new-mail)
- [Testing](#testing)
- [Limits](#limits)

## Pieces

| Where                                              | What                                                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/accounts/mailServer.ts`                       | Provider-neutral shapes for adding an account (settings, discovery, setup, certificate, `MailServerError`) and the `MailServerAccounts` interface the wizard uses |
| `src/app/mailServers.ts`                           | `MailServerAccounts` over the bridge, and the Yahoo/AOL app registrations (build or entered in the app)                                                           |
| `src/providers/imap/bridge.ts`                     | The contract with the native side: `imap_call` operations and their JSON, bytes, append, send                                                                     |
| `src/providers/imap/ImapProvider.ts`, `mappers.ts` | The `MailProvider`: folders and views, archive/trash/spam semantics, drafts, sending, signatures                                                                  |
| `src/providers/imap/ImapSession.ts`, `module.ts`   | The session (no tokens; `reauth: "password"`) and the module (`connect(setup)`, account ids `imap:<address>`)                                                     |
| `src/platform/native/imap.ts`                      | The bridge over Tauri commands; raw bytes for messages and attachments                                                                                            |
| `src/ui/accounts/MailServerFlow.tsx`               | The wizard's steps: address, settings and password, certificate                                                                                                   |
| `src-tauri/src/imap/`                              | The native side: connections and pool, TLS and pinning, discovery, own SMTP client, Yahoo/AOL OAuth, folders, listing, search, threads, parsing, sync, IDLE       |

The provider is described in [providers.md](providers.md#imap-and-smtp), the native side in [desktop-app.md](desktop-app.md#imap-and-smtp).

## Adding an account

1. **Address and name.** `imap_discover` looks the settings up, the way Thunderbird does: the provider's own autoconfig file (`https://autoconfig.<domain>/mail/config-v1.1.xml`, `https://<domain>/.well-known/autoconfig/…`), then Mozilla's provider database (ISPDB, `autoconfig.thunderbird.net`, which learns only the domain), then the domain's MX records (desktop only). A small table adds app-password and "switch IMAP on" pages for well-known providers. Gmail and Microsoft addresses are offered their own account types (`better`); Gmail over IMAP stays possible.
2. **Settings and password.** The found settings (or the usual `imap.`/`smtp.` names when nothing was found) are shown and editable. The password goes straight to the native side.
3. **Connect.** `imap_connect` logs in to IMAP and SMTP with the settings; only if both work is the account kept, in `imap.vault` (password, settings, a trusted certificate's fingerprint, the SMTP size limit). The wizard then calls `registry.add("imap", setup)` through `MailServerAccounts.add`, and the Inbox opens.

A password that stops working (`auth` from any call) makes the session `expired`; the Reconnect bar then has a password field, and `imap_reconnect` checks the new password before keeping it.

## Certificates and TLS

Connections are always encrypted: TLS from the start, or STARTTLS that must succeed (capabilities are read again after it). A login is never sent in plain text.

A certificate the system doesn't trust (a self-made one on your own server) is shown while adding the account, with its SHA-256 fingerprint, names, issuer and dates. If the user trusts it, that exact certificate is accepted for this account from then on, besides the ones the system trusts (RFC 8314: only while setting up, only for that account). A different untrusted certificate later is refused, never offered as a click-through warning. "Forget certificate" in the Accounts panel drops it. One trusted certificate per account: if IMAP and SMTP both have their own self-made certificates, only one of them can be trusted.

## Yahoo and AOL sign-in

Yahoo and AOL accept app passwords, and OAuth (XOAUTH2/OAUTHBEARER) for apps Yahoo has approved: mail access isn't self-service, Yahoo reviews registrations by hand, and AOL needs its own. action0 builds the sign-in in, with the client ID from `VITE_YAHOO_CLIENT_ID` / `VITE_AOL_CLIENT_ID` (and `…_CLIENT_SECRET` if Yahoo gave one) or entered in the wizard (`a0.settings.oauthClient.<provider>`). The redirect to register is `http://127.0.0.1` (the port varies). The refresh token is kept in `imap.vault`, access tokens in memory.

## The mail model

An IMAP account is a folder account, like Outlook:

- **Folders** come with roles from the server's special-use flags (RFC 6154), else from their names (German ones included), and unread counts. Views: Flagged (`v:flagged`), and the hidden All mail (`v:all`) that "Everywhere" searches: every folder but Trash and Junk.
- **Ids** stay the same when mail moves: the server's `EMAILID` (RFC 8474) or Gmail's `X-GM-MSGID` where it has them; otherwise a location id from where action0 first saw the message, and the native side follows moves while it runs. After a restart such ids are fresh again, so an old link may not open a message that moved.
- **Archive, Trash and Junk** move into the folder with that role, created the first time an account has none. Undo moves back into the Inbox (IMAP doesn't remember where mail was).
- **Search** runs on the server: words, `from:`, `to:`, `subject:`, `is:unread`, `is:starred`.
- **Conversations** are built from Message-ID / In-Reply-To / References (or the server's thread ids); opening one also finds your replies in Sent and messages in Archive.
- **Sending** builds the mail with `buildMessage`, sends it over SMTP without the Bcc header, and keeps a copy with it in Sent (Gmail's SMTP keeps its own). Drafts live in Drafts, replaced on every save.
- **Signatures** are kept in the app; From is the account's address with the name given when adding it; address suggestions come from recent mail.
- **Invitations** show without answer buttons until CalDAV arrives.

## New mail

The app checks every account every 60 s in front and every 5 minutes in the background (`changesSince`), using the server's change tracking where it has it (CONDSTORE/QRESYNC) and comparing the newest messages otherwise. In the desktop app, IDLE on each account's Inbox tells the app at once (`imap-changed`, which triggers the same check). Android's background check looks for new unread Inbox mail of IMAP accounts too.

## Testing

- `src/providers/imap/ImapProvider.test.ts`: the provider against `fakeImapBridge()` (`src/test/imapBridge.ts`), an in-memory account with folders, messages, appends and sends.
- `src/ui/imap.test.tsx`: the wizard (settings found, Gmail addresses, an untrusted certificate, a refused password), Reconnect with a password, Forget certificate. `renderApp({ imap: bridge })` adds the module.
- `src-tauri/src/imap/`: unit tests against a scripted IMAP server over an in-memory stream, discovery against a mock HTTP server, certificates made in the test; `#[ignore]` live tests against a real server (`ACTION0_IMAP_TEST=1`, see `live.rs`), for example Dovecot in Docker.

## Limits

- Desktop and Android apps only; no POP3.
- Further From addresses are kept in the app (`SenderStore`); whether the SMTP server accepts them is up to it.
- Moved messages on servers without `EMAILID` get new ids after a restart.
- On servers without UIDPLUS, moved or deleted messages stay marked `\Deleted` (and hidden in action0) when another program has marked other messages in that folder, until it's expunged.
- One trusted certificate per account.
- Yahoo/AOL OAuth needs a registration Yahoo approved.
- CalDAV (calendars, answering invitations) is a separate feature.
