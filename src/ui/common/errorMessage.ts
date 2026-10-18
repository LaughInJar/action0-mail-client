import { isMailError } from "../../core/errors";
import type { I18n } from "../../i18n/context";

/**
 * A message suitable for showing to the user, in the interface language:
 * known causes by their reason, others as the provider said them.
 */
export function errorMessage(error: unknown, t: I18n): string {
  if (isMailError(error)) {
    if (error.reason !== undefined)
      return t.errors.reasons[error.reason](error.params);
    switch (error.code) {
      case "auth-required":
      case "unavailable":
      case "provider":
        return error.message;
      case "not-found":
        return t.errors.notFound;
      case "rate-limited":
        return t.errors.rateLimited;
      case "network":
        return t.errors.offline;
    }
  }
  return error instanceof Error ? error.message : t.errors.unknown;
}
