import { describe, expect, it } from "vitest";
import { parseListUnsubscribe } from "./unsubscribe";

const POST = "List-Unsubscribe=One-Click";

describe("parseListUnsubscribe", () => {
  it("offers one-click only with an https URL and the post header", () => {
    expect(parseListUnsubscribe("<https://news.example/u?id=1>", POST)).toEqual(
      {
        oneClick: "https://news.example/u?id=1",
        page: "https://news.example/u?id=1",
      },
    );
    expect(
      parseListUnsubscribe("<https://news.example/u?id=1>", undefined),
    ).toEqual({ page: "https://news.example/u?id=1" });
    expect(parseListUnsubscribe("<http://news.example/u>", POST)).toEqual({
      page: "http://news.example/u",
    });
    expect(
      parseListUnsubscribe("<https://news.example/u>", "List-Unsubscribe=Yes"),
    ).toEqual({ page: "https://news.example/u" });
  });

  it("splits mailto URLs into address, subject and body", () => {
    expect(
      parseListUnsubscribe(
        "<mailto:leave%2Blist@lists.example?subject=unsubscribe%20me&body=a+b>, <https://lists.example/leave>",
        POST,
      ),
    ).toEqual({
      oneClick: "https://lists.example/leave",
      mail: {
        to: "leave+list@lists.example",
        subject: "unsubscribe me",
        // RFC 6068: "+" stays a plus.
        body: "a+b",
      },
      page: "https://lists.example/leave",
    });
    expect(parseListUnsubscribe("<mailto:off@lists.example>", POST)).toEqual({
      mail: { to: "off@lists.example" },
    });
  });

  it("prefers https pages and copes with folded headers", () => {
    expect(
      parseListUnsubscribe(
        "<http://a.example/u>,\r\n <https://b.example/\r\n u>",
        POST,
      ),
    ).toEqual({ oneClick: "https://b.example/u", page: "https://b.example/u" });
  });

  it("ignores what it can't use", () => {
    expect(parseListUnsubscribe(undefined, POST)).toBeUndefined();
    expect(parseListUnsubscribe("", POST)).toBeUndefined();
    expect(parseListUnsubscribe("https://no-brackets.example", POST)).toBe(
      undefined,
    );
    expect(parseListUnsubscribe("<javascript:alert(1)>", POST)).toBeUndefined();
    expect(parseListUnsubscribe("<mailto:not-an-address>", POST)).toBe(
      undefined,
    );
    expect(parseListUnsubscribe("<mailto:%E0%A4%A>", POST)).toBeUndefined();
  });
});
