// @vitest-environment node
import { describe, expect, it } from "vitest";
import { asAccountId, asMailboxId } from "../../core/ids";
import { newMailAccount } from "./useComposeActions";

const A = asAccountId("gmail:a@example.com");
const B = asAccountId("microsoft:b@example.com");
const inbox = asMailboxId("inbox");
const all = () => true;

describe("the account a new mail starts from", () => {
  it("is the account in context inside its mailboxes", () => {
    expect(
      newMailAccount({ accountId: B, mailboxId: inbox }, A, [A, B], all),
    ).toBe(B);
  });

  it("is the account used last in All inboxes", () => {
    const unified = { accountId: A, mailboxId: inbox, unified: true as const };
    expect(newMailAccount(unified, B, [A, B], all)).toBe(B);
    // Unknown (or removed) account: the one in context.
    expect(newMailAccount(unified, "gone", [A, B], all)).toBe(A);
    // One that can't write: the first that can.
    expect(newMailAccount(unified, B, [A, B], (id) => id === A)).toBe(A);
  });

  it("is none inside an account that can't write", () => {
    expect(
      newMailAccount(
        { accountId: B, mailboxId: inbox },
        A,
        [A, B],
        (id) => id === A,
      ),
    ).toBeUndefined();
    expect(newMailAccount(null, undefined, [A, B], (id) => id === B)).toBe(B);
  });
});
