import { COMPOSER_BODY_ID } from "./RichTextEditor";

/** DOM ids of the composer's fields (there is one composer at a time). */
export const COMPOSER_IDS = {
  to: "composer-to",
  cc: "composer-cc",
  bcc: "composer-bcc",
  subject: "composer-subject",
  body: COMPOSER_BODY_ID,
} as const;
