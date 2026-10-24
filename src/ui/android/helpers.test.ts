// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hexColor, shareMailto } from "./helpers";

describe("shareMailto", () => {
  it("turns a share into a mailto: link (text in the body)", () => {
    expect(
      shareMailto({
        to: ["anna@example.org", "max@contoso.com"],
        subject: "Fotos & mehr",
        text: "Look: https://example.org/?a=1&b=2",
        files: [],
      }),
    ).toBe(
      "mailto:anna%40example.org,max%40contoso.com?subject=Fotos%20%26%20mehr&body=Look%3A%20https%3A%2F%2Fexample.org%2F%3Fa%3D1%26b%3D2",
    );
    expect(shareMailto({ to: [], files: [] })).toBe("mailto:");
  });
});

describe("hexColor", () => {
  it("reads computed colours", () => {
    expect(hexColor("rgb(9, 9, 11)")).toBe("#09090b");
    expect(hexColor("rgba(255, 255, 255, 1)")).toBe("#ffffff");
    expect(hexColor("transparent")).toBe("#ffffff");
  });
});
