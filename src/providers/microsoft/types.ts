/**
 * The parts of Microsoft Graph's resources that action0 reads (only what it
 * `$select`s). Field names follow Graph.
 */

/** Graph's error answer. */
export interface GraphErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

/** A collection page. */
export interface GraphPage<T> {
  readonly value?: readonly T[];
  readonly "@odata.nextLink"?: string;
  readonly "@odata.deltaLink"?: string;
}

export interface GraphRecipient {
  readonly emailAddress?: { readonly name?: string; readonly address?: string };
}

/** One of the user's Outlook categories (`me/outlook/masterCategories`). */
export interface GraphCategory {
  readonly id: string;
  readonly displayName: string;
  /** `preset0` … `preset24`, or `none`. */
  readonly color?: string;
}

/** A Focused Inbox rule for a sender (`me/inferenceClassification/overrides`). */
export interface GraphFocusOverride {
  readonly id: string;
  readonly classifyAs: "focused" | "other";
  readonly senderEmailAddress: {
    readonly name?: string | null;
    readonly address: string;
  };
}

export interface GraphMailFolder {
  readonly id: string;
  readonly displayName?: string;
  readonly parentFolderId?: string;
  readonly childFolderCount?: number;
  readonly unreadItemCount?: number;
  readonly totalItemCount?: number;
  readonly isHidden?: boolean;
}

export interface GraphHeader {
  readonly name: string;
  readonly value: string;
}

export interface GraphMessage {
  readonly id: string;
  /** Set for derived types, e.g. `#microsoft.graph.eventMessageRequest`. */
  readonly "@odata.type"?: string;
  /** Event messages: what the mail does with its event. */
  readonly meetingMessageType?: string;
  /** Event messages: the event, when expanded. */
  readonly event?: { readonly iCalUId?: string };
  readonly conversationId?: string;
  readonly parentFolderId?: string;
  readonly from?: GraphRecipient;
  readonly sender?: GraphRecipient;
  readonly toRecipients?: readonly GraphRecipient[];
  readonly ccRecipients?: readonly GraphRecipient[];
  readonly bccRecipients?: readonly GraphRecipient[];
  readonly replyTo?: readonly GraphRecipient[];
  readonly subject?: string | null;
  readonly bodyPreview?: string;
  readonly body?: {
    readonly contentType?: "html" | "text";
    readonly content?: string;
  };
  readonly receivedDateTime?: string;
  readonly createdDateTime?: string;
  readonly isRead?: boolean;
  readonly isDraft?: boolean;
  /** Names of its categories. */
  readonly categories?: readonly string[];
  /** Its side of the Focused Inbox (Inbox mail; elsewhere `focused`). */
  readonly inferenceClassification?: "focused" | "other";
  readonly hasAttachments?: boolean;
  readonly flag?: {
    readonly flagStatus?: "notFlagged" | "flagged" | "complete";
  };
  readonly internetMessageId?: string;
  readonly internetMessageHeaders?: readonly GraphHeader[];
  /** MAPI properties asked for with `$expand` (Send later's time). */
  readonly singleValueExtendedProperties?: readonly {
    readonly id: string;
    readonly value?: string;
  }[];
  /** Set on entries of a delta page for messages that left the folder. */
  readonly "@removed"?: { readonly reason?: string };
}

export interface GraphAttachment {
  readonly "@odata.type"?: string;
  readonly id: string;
  readonly name?: string;
  readonly contentType?: string;
  readonly size?: number;
  readonly isInline?: boolean;
  readonly contentId?: string | null;
}

export interface GraphUser {
  readonly displayName?: string | null;
  readonly mail?: string | null;
  readonly userPrincipalName?: string | null;
}

export interface GraphPerson {
  readonly displayName?: string;
  readonly scoredEmailAddresses?: readonly { readonly address?: string }[];
}

export interface GraphUploadSession {
  readonly uploadUrl: string;
}

/** A postal address of a contact. */
export interface GraphPhysicalAddress {
  readonly street?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly countryOrRegion?: string | null;
  readonly postalCode?: string | null;
}

/** An Outlook contact (`me/contacts`, `me/contactFolders/{id}/contacts`). */
export interface GraphContact {
  readonly id: string;
  readonly "@odata.etag"?: string;
  /** Delta: the contact is gone from the folder. */
  readonly "@removed"?: { readonly reason?: string };
  readonly changeKey?: string;
  readonly parentFolderId?: string;
  readonly displayName?: string | null;
  readonly givenName?: string | null;
  readonly middleName?: string | null;
  readonly surname?: string | null;
  readonly nickName?: string | null;
  readonly emailAddresses?: readonly {
    readonly name?: string | null;
    readonly address?: string | null;
  }[];
  readonly businessPhones?: readonly string[];
  readonly homePhones?: readonly string[];
  readonly mobilePhone?: string | null;
  readonly companyName?: string | null;
  readonly jobTitle?: string | null;
  readonly department?: string | null;
  readonly homeAddress?: GraphPhysicalAddress | null;
  readonly businessAddress?: GraphPhysicalAddress | null;
  readonly otherAddress?: GraphPhysicalAddress | null;
  /** A DateTimeOffset; Outlook keeps it near midnight or noon. */
  readonly birthday?: string | null;
  readonly businessHomePage?: string | null;
  readonly personalNotes?: string | null;
  readonly categories?: readonly string[];
}

/** A contact folder (`me/contactFolders`, `…/childFolders`). */
export interface GraphContactFolder {
  readonly id: string;
  readonly displayName?: string;
  readonly parentFolderId?: string;
}
