import type { MessageId } from "./ids";
import type { MessageFlags, MessageSummary } from "./model";
import type { MailProvider, MutationResult } from "./provider";

/**
 * A write operation as plain data, so it can be applied optimistically,
 * undone, tested, and (later) queued. Each provider translates intents into
 * its own API calls.
 */
export type MailIntent =
  | { readonly kind: "archive"; readonly ids: readonly MessageId[] }
  | { readonly kind: "unarchive"; readonly ids: readonly MessageId[] }
  | {
      readonly kind: "set-flags";
      readonly ids: readonly MessageId[];
      readonly flags: Partial<MessageFlags>;
    };

/** Runs an intent against a provider. */
export function runIntent(
  provider: MailProvider,
  intent: MailIntent,
  signal?: AbortSignal,
): Promise<MutationResult> {
  switch (intent.kind) {
    case "archive":
      return provider.archive(intent.ids, signal);
    case "unarchive":
      return provider.unarchive(intent.ids, signal);
    case "set-flags":
      return provider.setFlags(intent.ids, intent.flags, signal);
  }
}

/**
 * The intents that undo `intent`, given the messages as they were before.
 * Only messages that actually change are included; flag changes are grouped
 * by their previous value.
 */
export function inverseOf(
  intent: MailIntent,
  before: readonly MessageSummary[],
): MailIntent[] {
  switch (intent.kind) {
    case "archive":
      return [{ kind: "unarchive", ids: intent.ids }];
    case "unarchive":
      return [{ kind: "archive", ids: intent.ids }];
    case "set-flags": {
      const ids = new Set(intent.ids);
      const inverses: MailIntent[] = [];
      for (const flag of ["seen", "flagged"] as const) {
        const target = intent.flags[flag];
        if (target === undefined) continue;
        const changed = before
          .filter((m) => ids.has(m.id) && m.flags[flag] !== target)
          .map((m) => m.id);
        if (changed.length > 0) {
          inverses.push({
            kind: "set-flags",
            ids: changed,
            flags: { [flag]: !target },
          });
        }
      }
      return inverses;
    }
  }
}
