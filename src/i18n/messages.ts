import { accounts } from "./texts/accounts";
import { calendar } from "./texts/calendar";
import { actions } from "./texts/actions";
import { common } from "./texts/common";
import { composer } from "./texts/composer";
import { desktop } from "./texts/desktop";
import { errors } from "./texts/errors";
import { categories, folders, labels } from "./texts/labels";
import { layout } from "./texts/layout";
import { list } from "./texts/list";
import { mailboxes } from "./texts/mailboxes";
import { reader } from "./texts/reader";
import { settings } from "./texts/settings";
import { shortcuts } from "./texts/shortcuts";
import { unsubscribe } from "./texts/unsubscribe";

/**
 * Every text of the interface, by language. Each area keeps English and
 * German side by side (`texts/`); German is typed against English, so a
 * missing or mismatched German text fails the build.
 */
export const messages = {
  en: {
    accounts: accounts.en,
    actions: actions.en,
    calendar: calendar.en,
    common: common.en,
    composer: composer.en,
    desktop: desktop.en,
    errors: errors.en,
    categories: categories.en,
    folders: folders.en,
    labels: labels.en,
    layout: layout.en,
    list: list.en,
    mailboxes: mailboxes.en,
    reader: reader.en,
    settings: settings.en,
    shortcuts: shortcuts.en,
    unsubscribe: unsubscribe.en,
  },
  de: {
    accounts: accounts.de,
    actions: actions.de,
    calendar: calendar.de,
    common: common.de,
    composer: composer.de,
    desktop: desktop.de,
    errors: errors.de,
    categories: categories.de,
    folders: folders.de,
    labels: labels.de,
    layout: layout.de,
    list: list.de,
    mailboxes: mailboxes.de,
    reader: reader.de,
    settings: settings.de,
    shortcuts: shortcuts.de,
    unsubscribe: unsubscribe.de,
  },
};

/** The texts of one language. */
export type Messages = (typeof messages)["en"];
