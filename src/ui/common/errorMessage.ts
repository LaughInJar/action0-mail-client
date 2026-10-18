import { isMailError } from "../../core/errors";

/** A message suitable for showing to the user. */
export function errorMessage(error: unknown): string {
  if (isMailError(error)) {
    switch (error.code) {
      case "auth-required":
      case "provider":
        return error.message;
      case "not-found":
        return "This item no longer exists.";
      case "rate-limited":
        return "The mail provider is busy. Please try again in a moment.";
      case "network":
        return "You seem to be offline, or the mail provider can't be reached.";
    }
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
