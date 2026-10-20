// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseInvitation } from "./calendar";

const ics = (...lines: string[]) =>
  ["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n");

describe("parseInvitation", () => {
  it("reads the method and the event's UID, also from folded lines", () => {
    expect(
      parseInvitation(
        ics(
          "METHOD:REQUEST",
          "BEGIN:VEVENT",
          "UID:040000008200E00074C5B7101A82E0080000000",
          " 0F0A1B2C3D@outlook.example",
          "SUMMARY:Design review",
          "END:VEVENT",
        ),
      ),
    ).toEqual({
      uid: "040000008200E00074C5B7101A82E00800000000F0A1B2C3D@outlook.example",
      method: "request",
    });
    expect(
      parseInvitation(
        ics("METHOD:CANCEL", "BEGIN:VEVENT", "UID:a@b", "END:VEVENT"),
      ),
    ).toEqual({ uid: "a@b", method: "cancel" });
    expect(
      parseInvitation(
        ics("METHOD:REPLY", "BEGIN:VEVENT", "UID:a@b", "END:VEVENT"),
      ),
    ).toEqual({ uid: "a@b", method: "reply" });
  });

  it("ignores calendars that aren't invitations", () => {
    expect(
      parseInvitation(
        ics("METHOD:PUBLISH", "BEGIN:VEVENT", "UID:a@b", "END:VEVENT"),
      ),
    ).toBeUndefined();
    expect(
      parseInvitation(ics("BEGIN:VEVENT", "UID:a@b", "END:VEVENT")),
    ).toBeUndefined();
    expect(parseInvitation(ics("METHOD:REQUEST"))).toBeUndefined();
  });
});
