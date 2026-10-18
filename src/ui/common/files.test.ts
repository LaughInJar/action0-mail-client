// @vitest-environment node
import { describe, expect, it } from "vitest";
import { attachmentKind, megabytes } from "./files";

describe("attachmentKind", () => {
  it("previews images and PDFs, downloads everything else", () => {
    const kind = (mimeType: string, filename = "file") =>
      attachmentKind({ mimeType, filename });
    expect(kind("image/png")).toBe("image");
    expect(kind("IMAGE/JPEG; name=x.jpg")).toBe("image");
    expect(kind("image/svg+xml")).toBe("image");
    expect(kind("application/pdf")).toBe("pdf");
    expect(kind("application/octet-stream", "Invoice.PDF")).toBe("pdf");
    expect(kind("text/html")).toBe("download");
    expect(kind("application/xhtml+xml")).toBe("download");
    expect(kind("text/xml")).toBe("download");
    expect(kind("image/x-icon")).toBe("download");
    expect(kind("application/octet-stream", "setup.exe")).toBe("download");
  });

  it("writes sizes for limit messages", () => {
    expect(megabytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(megabytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});
