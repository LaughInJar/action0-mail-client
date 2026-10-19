import type { ProviderType } from "../../core/model";

/** A card in the "Add account" type selection (its texts: `t.accounts.types`). */
export interface AccountTypeCard {
  /** A provider type, or a placeholder for one that isn't built yet. */
  readonly type: ProviderType | "imap";
  /** Short mark shown on the card (no brand logos). */
  readonly mark: string;
  /** Not built yet: shown greyed out. */
  readonly comingLater?: boolean;
}

/** The account types, in display order. */
export const ACCOUNT_TYPE_CARDS: readonly AccountTypeCard[] = [
  { type: "gmail", mark: "G" },
  { type: "microsoft", mark: "M" },
  { type: "imap", mark: "@", comingLater: true },
  { type: "demo", mark: "D" },
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

/** Microsoft Entra pages used in the setup checklist. */
export const ENTRA_LINKS = {
  entra: "https://entra.microsoft.com/",
  registrations:
    "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade/quickStartType~/null/sourceType/Microsoft_AAD_IAM",
} as const;
