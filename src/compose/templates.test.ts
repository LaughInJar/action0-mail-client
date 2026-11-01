import { describe, expect, it } from "vitest";
import { asAccountId } from "../core/ids";
import {
  fillTemplate,
  recipientNames,
  templateSearchText,
  templatesFor,
  type MailTemplate,
} from "./templates";

describe("fillTemplate", () => {
  it("fills both languages' placeholders, in any case, escaped", () => {
    expect(
      fillTemplate("<p>Hi {first name}, {Name}! Hallo {Vorname} {NAME}</p>", {
        first: "Anna",
        full: "Anna <Berger>",
      }),
    ).toBe(
      "<p>Hi Anna, Anna &lt;Berger&gt;! Hallo Anna Anna &lt;Berger&gt;</p>",
    );
  });

  it("leaves placeholders empty when the name is unknown, and other braces alone", () => {
    expect(
      fillTemplate("Hi {first name}, {other}", { first: "", full: "" }),
    ).toBe("Hi , {other}");
  });
});

describe("recipientNames", () => {
  it("prefers the contact, then the display name", () => {
    expect(
      recipientNames(
        { name: "A. Berger", address: "a@example.org" },
        { given: "Anna", full: "Anna Berger" },
      ),
    ).toEqual({ first: "Anna", full: "Anna Berger" });
    expect(recipientNames({ name: "Lukas Hofer", address: "l@x" })).toEqual({
      first: "Lukas",
      full: "Lukas Hofer",
    });
    expect(recipientNames({ name: "Berger, Anna", address: "a@x" })).toEqual({
      first: "Anna",
      full: "Anna Berger",
    });
    expect(recipientNames({ address: "a@x" })).toEqual({
      first: "",
      full: "",
    });
    expect(recipientNames(undefined)).toEqual({ first: "", full: "" });
  });
});

describe("finding templates", () => {
  const all: MailTemplate = {
    id: "1",
    name: "Thanks",
    subject: "Re: your request",
    html: "<p>Danke für die Nachricht</p>",
  };
  const work: MailTemplate = {
    id: "2",
    name: "Offer",
    subject: "",
    html: "<p>Our offer</p>",
    accountId: asAccountId("demo:work"),
  };

  it("searches name, subject and text without accents", () => {
    expect(templateSearchText(all)).toContain("danke fur die nachricht");
    expect(templateSearchText(all)).toContain("your request");
  });

  it("offers an account its own templates and those for every account", () => {
    expect(templatesFor([all, work], asAccountId("demo:work"))).toEqual([
      all,
      work,
    ]);
    expect(templatesFor([all, work], asAccountId("demo:other"))).toEqual([all]);
  });
});
