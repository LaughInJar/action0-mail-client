import type { ProviderType } from "../../core/model";

/** A card in the "Add account" type selection. */
export interface AccountTypeCard {
  /** A provider type, or a placeholder for one that isn't built yet. */
  readonly type: ProviderType | "microsoft" | "imap";
  readonly title: string;
  readonly description: string;
  /** Short mark shown on the card (no brand logos). */
  readonly mark: string;
  /** Not built yet: shown greyed out. */
  readonly comingLater?: boolean;
}

/** The account types, in display order. */
export const ACCOUNT_TYPE_CARDS: readonly AccountTypeCard[] = [
  {
    type: "gmail",
    title: "Google",
    description: "Gmail and Google Workspace",
    mark: "G",
  },
  {
    type: "microsoft",
    title: "Microsoft",
    description: "Outlook.com, Microsoft 365 and Exchange Online",
    mark: "M",
    comingLater: true,
  },
  {
    type: "imap",
    title: "Other mail server",
    description: "Any provider with IMAP",
    mark: "@",
    comingLater: true,
  },
  {
    type: "demo",
    title: "Demo account",
    description: "Sample mail that lives only in this browser",
    mark: "D",
  },
];

/** Google Cloud pages used in the setup checklist. */
export const GOOGLE_CLOUD_LINKS = {
  gmailApi:
    "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  peopleApi:
    "https://console.cloud.google.com/apis/library/people.googleapis.com",
  authPlatform: "https://console.cloud.google.com/auth/overview",
  audience: "https://console.cloud.google.com/auth/audience",
  dataAccess: "https://console.cloud.google.com/auth/scopes",
  clients: "https://console.cloud.google.com/auth/clients",
} as const;
