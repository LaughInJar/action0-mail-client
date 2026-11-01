/**
 * The subset of Gmail API v1 resources this adapter uses.
 * @see https://developers.google.com/gmail/api/reference/rest
 */

export interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
  messageListVisibility?: "show" | "hide";
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
  /** Only returned by `labels.get`, not by `labels.list`. */
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: { textColor: string; backgroundColor: string };
}

export interface GmailListLabelsResponse {
  labels?: GmailLabel[];
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePartBody {
  /** Set when the content must be fetched separately via `attachments.get`. */
  attachmentId?: string;
  size: number;
  /** base64url-encoded content. */
  data?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** Epoch milliseconds as a string. */
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePart;
  /** The whole message, base64url (only with `format=raw`). */
  raw?: string;
}

export interface GmailListMessagesResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailListThreadsResponse {
  threads?: { id: string; snippet?: string; historyId?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** A thread from `threads.get`; messages oldest first. */
export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
}

/** A message reference in a history record. */
interface GmailHistoryMessage {
  message: { id: string; threadId?: string; labelIds?: string[] };
}

/** Response of `history.list`. */
export interface GmailHistoryResponse {
  history?: {
    id: string;
    messagesAdded?: GmailHistoryMessage[];
    messagesDeleted?: GmailHistoryMessage[];
    labelsAdded?: (GmailHistoryMessage & { labelIds?: string[] })[];
    labelsRemoved?: (GmailHistoryMessage & { labelIds?: string[] })[];
  }[];
  nextPageToken?: string;
  /** The mailbox's current history id. */
  historyId?: string;
}

export interface GmailAttachment {
  size: number;
  data: string;
}

export interface GmailDraft {
  id: string;
  /** Only `id`, `threadId` and `labelIds` unless fetched with `format=full`. */
  message?: GmailMessage;
}

export interface GmailListDraftsResponse {
  drafts?: { id: string; message?: { id: string; threadId: string } }[];
  nextPageToken?: string;
}

/** A send-as address (`settings.sendAs`). */
export interface GmailSendAs {
  sendAsEmail: string;
  displayName?: string;
  /** HTML. */
  signature?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  /** Aliases must be verified before Gmail sends from them. */
  verificationStatus?: "accepted" | "pending" | "verificationStatusUnspecified";
}

/** Response of `settings.sendAs.list`. */
export interface GmailListSendAsResponse {
  sendAs?: GmailSendAs[];
}

/** Where a field of a person comes from, and whether it's the main one. */
export interface PeopleFieldMetadata {
  primary?: boolean;
  /** `CONTACT` for the user's own contact data; `PROFILE` and others are read-only. */
  source?: { type?: string; id?: string; etag?: string };
}

/** One entry of a person's field. Unknown parts are kept when it's sent back. */
export interface PeopleEntry {
  metadata?: PeopleFieldMetadata;
  [key: string]: unknown;
}

export interface PeopleName extends PeopleEntry {
  displayName?: string;
  givenName?: string;
  middleName?: string;
  familyName?: string;
}

/** An email address, phone number, URL or nickname. */
export interface PeopleTyped extends PeopleEntry {
  value?: string;
  /** `home`, `work`, `other`, … or a label the user typed. */
  type?: string;
  /** The type as Google shows it ("Home fax"). */
  formattedType?: string;
}

export interface PeopleOrganization extends PeopleEntry {
  name?: string;
  title?: string;
  department?: string;
}

export interface PeopleAddress extends PeopleEntry {
  streetAddress?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  type?: string;
  formattedType?: string;
}

export interface PeopleBirthday extends PeopleEntry {
  /** `year` is absent (or 0) for a birthday without a year. */
  date?: { year?: number; month?: number; day?: number };
  text?: string;
}

export interface PeopleBiography extends PeopleEntry {
  value?: string;
  contentType?: string;
}

export interface PeopleMembership extends PeopleEntry {
  contactGroupMembership?: {
    contactGroupResourceName?: string;
    contactGroupId?: string;
  };
}

export interface PeoplePhoto extends PeopleEntry {
  url?: string;
  /** Google's placeholder (initials), not a picture of the person. */
  default?: boolean;
}

/** A person from the People API (contacts, other contacts, search results). */
export interface PeoplePerson {
  /** `people/c…` or `otherContacts/c…`. */
  resourceName?: string;
  etag?: string;
  metadata?: {
    deleted?: boolean;
    sources?: { type?: string; id?: string; etag?: string }[];
  };
  names?: PeopleName[];
  nicknames?: PeopleTyped[];
  emailAddresses?: PeopleTyped[];
  phoneNumbers?: PeopleTyped[];
  organizations?: PeopleOrganization[];
  addresses?: PeopleAddress[];
  birthdays?: PeopleBirthday[];
  urls?: PeopleTyped[];
  biographies?: PeopleBiography[];
  memberships?: PeopleMembership[];
  photos?: PeoplePhoto[];
  [field: string]: unknown;
}

/** Response of `people.connections.list`. */
export interface PeopleConnectionsResponse {
  connections?: PeoplePerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** Response of `otherContacts.list`. */
export interface OtherContactsResponse {
  otherContacts?: PeoplePerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** A contact group (label) of the People API. */
export interface PeopleContactGroup {
  resourceName?: string;
  etag?: string;
  name?: string;
  memberCount?: number;
  /** With `maxMembers`: who's in it. */
  memberResourceNames?: string[];
  /** The name in the user's language (system groups: "Starred"). */
  formattedName?: string;
  /** `USER_CONTACT_GROUP` or `SYSTEM_CONTACT_GROUP`. */
  groupType?: string;
}

/** Response of `contactGroups.list`. */
export interface PeopleContactGroupsResponse {
  contactGroups?: PeopleContactGroup[];
  nextPageToken?: string;
}

/** One answer of a People API batch (`people:batchGet`, `people:batchCreateContacts`). */
export interface PeopleBatchItem {
  httpStatusCode?: number;
  person?: PeoplePerson;
  status?: { code?: number; message?: string };
}

/** Response of `people:searchContacts` and `otherContacts:search`. */
export interface PeopleSearchResponse {
  results?: { person?: PeoplePerson }[];
}

/** Error body returned by Google APIs. */
export interface GoogleApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: { reason?: string }[];
    status?: string;
  };
}
