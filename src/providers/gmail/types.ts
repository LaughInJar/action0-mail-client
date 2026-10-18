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
}

export interface GmailListMessagesResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
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

/** A person from the People API (`readMask=names,emailAddresses`). */
export interface PeoplePerson {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
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
