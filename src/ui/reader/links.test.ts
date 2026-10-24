import { describe, expect, it, vi } from "vitest";
import { followLinkClick } from "./links";

describe("clicks on links in mail", () => {
  it("go to the platform, and do nothing else if it took them", () => {
    document.body.innerHTML =
      '<p><a href="https://example.org/news"><b>News</b></a> <span>text</span></p>';
    const followLink = vi.fn(() => true);
    const click = (selector: string) => {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      document.querySelector(selector)?.dispatchEvent(event);
      return event;
    };
    document.addEventListener("click", (event) => {
      followLinkClick(event, followLink);
    });

    // A click inside the link counts as one on the link.
    expect(click("b").defaultPrevented).toBe(true);
    expect(followLink).toHaveBeenCalledWith("https://example.org/news");
    expect(click("span").defaultPrevented).toBe(false);

    followLink.mockReturnValue(false);
    expect(click("a").defaultPrevented).toBe(false);
  });
});
