const en = {
  // The Move to… and Labels pickers.
  labels: "Labels",
  moveTo: "Move to",
  applyAndClose: "Apply and close",
  filterLabels: "Filter labels",
  filterMailboxes: "Filter mailboxes",
  findLabel: "Find a label",
  findMailbox: "Find a mailbox",
  labelsHint:
    "↑↓ to choose · Space or click to toggle · Enter applies · Esc cancels",
  moveHint: "↑↓ to choose · Enter moves · Esc cancels",
  nothingMatches: "Nothing matches.",
  creating: "Creating…",
  createLabel: (path: string) => `Create label “${path}”`,
  apply: "Apply",

  // The label dialog.
  nameMissing: "Give the label a name.",
  noSlash: "Names can’t contain “/”. Choose a parent instead.",
  preview: "Label",
  newLabel: "New label",
  newLabelIn: (parent: string) => `New label in “${parent}”`,
  editLabel: (name: string) => `Edit label “${name}”`,
  name: "Name",
  inside: "Inside",
  topLevel: "Nothing (top level)",
  colour: "Colour",
  noColour: "No colour",
  showInList: "Show in the folder list",

  // The label menu.
  closeMenu: "Close menu",
  menuOf: (name: string) => `Label ${name}`,
  rename: "Rename…",
  colourMenu: "Colour…",
  moveUnder: "Move under…",
  addSublabel: "Add sublabel…",
  showInFolderList: "Show in folder list",
  hideFromFolderList: "Hide from folder list",
  deleteMenu: "Delete…",
  /** In place of Rename where it can't be done (Outlook categories). */
  cantRename: "Outlook can’t rename categories.",

  // Manage labels.
  manageLabels: "Manage labels",
  loadingLabels: "Loading labels…",
  noLabels: "No labels yet.",
  allLabels: "All labels",
  hidden: "hidden",
  editNamed: (name: string) => `Edit ${name}`,
  show: "Show",
  hide: "Hide",
  showNamed: (name: string) => `Show ${name}`,
  hideNamed: (name: string) => `Hide ${name}`,
  deleteNamed: (name: string) => `Delete ${name}`,

  // Toasts and confirmation.
  saved: (name: string) => `Saved label “${name}”`,
  renamed: (before: string, name: string) => `Renamed “${before}” to “${name}”`,
  movedUnder: (name: string, parent: string) =>
    `Moved “${name}” under “${parent}”`,
  movedToTop: (name: string) => `Moved “${name}” to the top level`,
  colourChanged: (name: string) => `Changed the colour of “${name}”`,
  colourRemoved: (name: string) => `Removed the colour of “${name}”`,
  hiddenNow: (name: string) => `Hid “${name}” from the folder list`,
  shownAgain: (name: string) => `“${name}” shows in the folder list again`,
  created: (name: string) => `Created label “${name}”`,
  couldntChange: "Couldn’t change the label",
  deleteTitle: (name: string) => `Delete label “${name}”?`,
  deleteMessage: (nested: boolean) =>
    `Messages keep their other labels${nested ? ", and the labels inside it stay" : ""}. This can’t be undone.`,
  deleteLabel: "Delete label",
  deleted: (name: string) => `Deleted label “${name}”`,
  couldntDelete: (name: string) => `Couldn’t delete “${name}”`,

  /** Colour names for screen readers ("dark green"). */
  colours: {
    red: "red",
    orange: "orange",
    yellow: "yellow",
    green: "green",
    teal: "teal",
    blue: "blue",
    purple: "purple",
    pink: "pink",
    white: "white",
    black: "black",
    grey: "grey",
    darkGrey: "dark grey",
    deep: (hue: string) => `deep ${hue}`,
    dark: (hue: string) => `dark ${hue}`,
    light: (hue: string) => `light ${hue}`,
  },
};

const de: typeof en = {
  labels: "Labels",
  moveTo: "Verschieben nach",
  applyAndClose: "Übernehmen und schließen",
  filterLabels: "Labels filtern",
  filterMailboxes: "Ordner filtern",
  findLabel: "Label suchen",
  findMailbox: "Ordner suchen",
  labelsHint:
    "↑↓ wählen · Leertaste/Klick: an/aus · Eingabe übernimmt · Esc bricht ab",
  moveHint: "↑↓ wählen · Eingabe verschiebt · Esc bricht ab",
  nothingMatches: "Nichts gefunden.",
  creating: "Wird erstellt …",
  createLabel: (path) => `Label „${path}“ erstellen`,
  apply: "Übernehmen",

  nameMissing: "Gib dem Label einen Namen.",
  noSlash:
    "Namen dürfen kein „/“ enthalten. Wähl stattdessen ein übergeordnetes Label.",
  preview: "Label",
  newLabel: "Neues Label",
  newLabelIn: (parent) => `Neues Label in „${parent}“`,
  editLabel: (name) => `Label „${name}“ bearbeiten`,
  name: "Name",
  inside: "In",
  topLevel: "Nichts (oberste Ebene)",
  colour: "Farbe",
  noColour: "Keine Farbe",
  showInList: "In der Ordnerliste anzeigen",

  closeMenu: "Menü schließen",
  menuOf: (name) => `Label ${name}`,
  rename: "Umbenennen …",
  colourMenu: "Farbe …",
  moveUnder: "Verschieben unter …",
  addSublabel: "Unterlabel hinzufügen …",
  showInFolderList: "In der Ordnerliste anzeigen",
  hideFromFolderList: "In der Ordnerliste ausblenden",
  deleteMenu: "Löschen …",
  cantRename: "Outlook kann Kategorien nicht umbenennen.",

  manageLabels: "Labels verwalten",
  loadingLabels: "Labels werden geladen …",
  noLabels: "Noch keine Labels.",
  allLabels: "Alle Labels",
  hidden: "ausgeblendet",
  editNamed: (name) => `${name} bearbeiten`,
  show: "Einblenden",
  hide: "Ausblenden",
  showNamed: (name) => `${name} einblenden`,
  hideNamed: (name) => `${name} ausblenden`,
  deleteNamed: (name) => `${name} löschen`,

  saved: (name) => `Label „${name}“ gespeichert`,
  renamed: (before, name) => `„${before}“ in „${name}“ umbenannt`,
  movedUnder: (name, parent) => `„${name}“ unter „${parent}“ verschoben`,
  movedToTop: (name) => `„${name}“ auf die oberste Ebene verschoben`,
  colourChanged: (name) => `Farbe von „${name}“ geändert`,
  colourRemoved: (name) => `Farbe von „${name}“ entfernt`,
  hiddenNow: (name) => `„${name}“ in der Ordnerliste ausgeblendet`,
  shownAgain: (name) => `„${name}“ wird wieder in der Ordnerliste angezeigt`,
  created: (name) => `Label „${name}“ erstellt`,
  couldntChange: "Ändern des Labels fehlgeschlagen",
  deleteTitle: (name) => `Label „${name}“ löschen?`,
  deleteMessage: (nested) =>
    `Nachrichten behalten ihre anderen Labels${nested ? ", und die Labels darin bleiben bestehen" : ""}. Das lässt sich nicht rückgängig machen.`,
  deleteLabel: "Label löschen",
  deleted: (name) => `Label „${name}“ gelöscht`,
  couldntDelete: (name) => `„${name}“ konnte nicht gelöscht werden`,

  colours: {
    red: "rot",
    orange: "orange",
    yellow: "gelb",
    green: "grün",
    teal: "türkis",
    blue: "blau",
    purple: "lila",
    pink: "rosa",
    white: "weiß",
    black: "schwarz",
    grey: "grau",
    darkGrey: "dunkelgrau",
    deep: (hue) => `tief${hue}`,
    dark: (hue) => `dunkel${hue}`,
    light: (hue) => `hell${hue}`,
  },
};

/** Labels: the pickers, the label dialog and menu, Manage labels. */
export const labels = { en, de };

/**
 * The same texts for accounts with folders (Outlook): what differs from the
 * label wording. Folders have no colours and can't be hidden.
 */
const enFolders: typeof en = {
  ...en,
  filterLabels: "Filter folders",
  findLabel: "Find a folder",
  createLabel: (path) => `Create folder “${path}”`,
  nameMissing: "Give the folder a name.",
  noSlash: "Names can’t contain “/”. Choose a parent folder instead.",
  preview: "Folder",
  newLabel: "New folder",
  newLabelIn: (parent) => `New folder in “${parent}”`,
  editLabel: (name) => `Edit folder “${name}”`,
  menuOf: (name) => `Folder ${name}`,
  moveUnder: "Move into…",
  addSublabel: "Add subfolder…",
  manageLabels: "Manage folders",
  loadingLabels: "Loading folders…",
  noLabels: "No folders of your own yet.",
  allLabels: "All folders",
  saved: (name) => `Saved folder “${name}”`,
  movedUnder: (name, parent) => `Moved “${name}” into “${parent}”`,
  created: (name) => `Created folder “${name}”`,
  couldntChange: "Couldn’t change the folder",
  deleteTitle: (name) => `Delete folder “${name}”?`,
  deleteMessage: (nested) =>
    nested
      ? "The folder, the folders inside it and all their messages move to Deleted Items, where you can restore them."
      : "The folder and its messages move to Deleted Items, where you can restore them.",
  deleteLabel: "Delete folder",
  deleted: (name) => `Deleted folder “${name}”`,
};

const deFolders: typeof en = {
  ...de,
  filterLabels: "Ordner filtern",
  findLabel: "Ordner suchen",
  createLabel: (path) => `Ordner „${path}“ erstellen`,
  nameMissing: "Gib dem Ordner einen Namen.",
  noSlash:
    "Namen dürfen kein „/“ enthalten. Wähl stattdessen einen übergeordneten Ordner.",
  preview: "Ordner",
  newLabel: "Neuer Ordner",
  newLabelIn: (parent) => `Neuer Ordner in „${parent}“`,
  editLabel: (name) => `Ordner „${name}“ bearbeiten`,
  menuOf: (name) => `Ordner ${name}`,
  moveUnder: "Verschieben in …",
  addSublabel: "Unterordner hinzufügen …",
  manageLabels: "Ordner verwalten",
  loadingLabels: "Ordner werden geladen …",
  noLabels: "Noch keine eigenen Ordner.",
  allLabels: "Alle Ordner",
  saved: (name) => `Ordner „${name}“ gespeichert`,
  movedUnder: (name, parent) => `„${name}“ nach „${parent}“ verschoben`,
  created: (name) => `Ordner „${name}“ erstellt`,
  couldntChange: "Ändern des Ordners fehlgeschlagen",
  deleteTitle: (name) => `Ordner „${name}“ löschen?`,
  deleteMessage: (nested) =>
    nested
      ? "Der Ordner, die Ordner darin und alle ihre Nachrichten kommen in „Gelöschte Elemente“, wo du sie wiederherstellen kannst."
      : "Der Ordner und seine Nachrichten kommen in „Gelöschte Elemente“, wo du sie wiederherstellen kannst.",
  deleteLabel: "Ordner löschen",
  deleted: (name) => `Ordner „${name}“ gelöscht`,
};

/** {@link labels} in folder wording, for folder-based accounts. */
export const folders = { en: enFolders, de: deFolders };

/**
 * The same texts for Outlook's categories (labels next to folders): they
 * can't be renamed or nested; deleting one leaves the mail as it is.
 */
const enCategories: typeof en = {
  ...en,
  labels: "Categories",
  filterLabels: "Filter categories",
  findLabel: "Find a category",
  createLabel: (path) => `Create category “${path}”`,
  nameMissing: "Give the category a name.",
  preview: "Category",
  newLabel: "New category",
  newLabelIn: () => "New category",
  editLabel: (name) => `Category “${name}”`,
  menuOf: (name) => `Category ${name}`,
  manageLabels: "Manage categories",
  loadingLabels: "Loading categories…",
  noLabels: "No categories yet.",
  allLabels: "Categories",
  saved: (name) => `Saved category “${name}”`,
  created: (name) => `Created category “${name}”`,
  couldntChange: "Couldn’t change the category",
  deleteTitle: (name) => `Delete category “${name}”?`,
  deleteMessage: () =>
    "It leaves your list of categories. Mail that has it keeps the name in Outlook, without a colour. This can’t be undone.",
  deleteLabel: "Delete category",
  deleted: (name) => `Deleted category “${name}”`,
};

const deCategories: typeof en = {
  ...de,
  labels: "Kategorien",
  filterLabels: "Kategorien filtern",
  findLabel: "Kategorie suchen",
  createLabel: (path) => `Kategorie „${path}“ erstellen`,
  nameMissing: "Gib der Kategorie einen Namen.",
  preview: "Kategorie",
  newLabel: "Neue Kategorie",
  newLabelIn: () => "Neue Kategorie",
  editLabel: (name) => `Kategorie „${name}“`,
  menuOf: (name) => `Kategorie ${name}`,
  manageLabels: "Kategorien verwalten",
  loadingLabels: "Kategorien werden geladen …",
  noLabels: "Noch keine Kategorien.",
  allLabels: "Kategorien",
  saved: (name) => `Kategorie „${name}“ gespeichert`,
  created: (name) => `Kategorie „${name}“ erstellt`,
  couldntChange: "Ändern der Kategorie fehlgeschlagen",
  deleteTitle: (name) => `Kategorie „${name}“ löschen?`,
  deleteMessage: () =>
    "Sie verschwindet aus deiner Kategorienliste. E-Mails damit behalten den Namen in Outlook, ohne Farbe. Das lässt sich nicht rückgängig machen.",
  deleteLabel: "Kategorie löschen",
  deleted: (name) => `Kategorie „${name}“ gelöscht`,
};

/** {@link labels} in category wording, for Outlook's categories. */
export const categories = { en: enCategories, de: deCategories };
