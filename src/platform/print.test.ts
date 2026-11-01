import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPrint } from "./native/desktop";
import { printNatively, printWindow } from "./print";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.title = "action0";
});

describe("printWindow", () => {
  it("names the job by the title while printing, until afterprint", async () => {
    document.title = "action0";
    let during = "";
    vi.spyOn(window, "print").mockImplementation(() => {
      during = document.title;
    });
    const printed = printWindow(window, "Trip to Lake Como");
    expect(during).toBe("Trip to Lake Como");
    window.dispatchEvent(new Event("afterprint"));
    await printed;
    expect(document.title).toBe("action0");
  });

  it("finishes by itself where no afterprint comes", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "print").mockImplementation(() => undefined);
    const printed = printWindow(window, "Report");
    await vi.advanceTimersByTimeAsync(1000);
    await printed;
    expect(document.title).toBe("action0");
  });
});

describe("printNatively", () => {
  it("waits until the user is back in the page", async () => {
    const start = vi.fn(() => Promise.resolve());
    let finished = false;
    const printed = printNatively(window, "Report", start).then(() => {
      finished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();
    expect(document.title).toBe("Report");
    expect(finished).toBe(false);
    window.dispatchEvent(new Event("pointerdown"));
    await printed;
    expect(document.title).toBe("action0");
  });

  it("restores the title when the dialog can't open", async () => {
    await expect(
      printNatively(window, "Report", () => Promise.reject(new Error("no"))),
    ).rejects.toThrow("no");
    expect(document.title).toBe("action0");
  });
});

describe("desktopPrint", () => {
  it("asks the native side on macOS and uses window.print elsewhere", async () => {
    const panel = vi.fn(() => Promise.resolve());
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    await desktopPrint("linux", panel)("Report");
    expect(print).toHaveBeenCalledOnce();
    expect(panel).not.toHaveBeenCalled();

    const mac = desktopPrint("macos", panel)("Report");
    await Promise.resolve();
    expect(panel).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("keydown"));
    await mac;
    expect(print).toHaveBeenCalledOnce();
  });
});
