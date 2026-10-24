# action0 developer documentation

These documents explain how action0 works inside: its architecture, the reasoning behind it, and how to develop, test, build and release it. They're written for someone new to the code (or anyone coming back to it after a while). For what action0 does and how to set it up as a user, start with the [README](../README.md).

## Where to start

| If you want to…                                             | Read                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| Get the big picture and follow a click to the provider      | [architecture.md](architecture.md)                     |
| Understand mailboxes, intents, capabilities and IDs         | [domain-model.md](domain-model.md)                     |
| Work on Gmail, Outlook or iCal, or add a provider           | [providers.md](providers.md)                           |
| Know why something is built the way it is                   | [decisions.md](decisions.md)                           |
| Set up a development environment and follow the conventions | [development.md](development.md)                       |
| Write or run tests                                          | [testing.md](testing.md)                               |
| Build the web app or the desktop app, and host it           | [building-and-deploying.md](building-and-deploying.md) |
| Ship a release                                              | [releasing.md](releasing.md)                           |
| Work on the Tauri desktop app                               | [desktop-app.md](desktop-app.md)                       |
| Work on the Android app                                     | [android.md](android.md)                               |
| Understand tokens, storage and HTML mail safety             | [security.md](security.md)                             |

The approved decisions, including small UX choices, are listed in the decisions log in [`CLAUDE.md`](../CLAUDE.md#decisions-log), which also describes the mandatory way of working.

## Glossary

| Term            | Meaning                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Account         | A connected Gmail, Microsoft or demo account: an `AccountHandle` with its session, mail provider and optional calendar provider           |
| Provider        | An adapter that implements `MailProvider` (and `CalendarProvider`) for one service: Gmail, Graph, iCal, or the in-memory fake             |
| Mailbox         | Anything a message can be in: a label, a folder or a computed view, with an optional role such as `inbox` or `trash`                      |
| Category        | An Outlook category; shown and handled as a label next to Outlook's folders                                                               |
| Intent          | A change to mail as plain data (`archive`, `move`, `set-labels`, …), predicted, applied optimistically and undone with its inverse        |
| Capabilities    | What a provider supports (`archive`, `labels`, `threads`, `mailboxEditing`, …); the UI checks them instead of asking which provider it is |
| Row             | One line of the message list: a message, or a conversation by its oldest message                                                          |
| `MessageKey`    | Account and message ID together, identifying a row across accounts (All inboxes)                                                          |
| All inboxes     | Every account's Inbox merged by date into one list                                                                                        |
| Context account | In All inboxes, the account of the open message; the route carries it so the reader and shortcuts know which account they act on          |
| Source          | One account's part of a list (its mailbox, conversations or not); or, in the calendar, one account or iCal subscription                   |
| Platform        | The interface that hides what differs between the web app, the desktop app and the Android app                                            |
| Native side     | The desktop and Android apps' Rust code in `src-tauri/` (and, on Android, the Kotlin plugin in `src-tauri/plugins/action0`)               |
| Demo accounts   | Two in-memory accounts (Gmail-like and Outlook-like) opened with `/?demo`                                                                 |
