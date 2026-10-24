// @vitest-environment node
import { describe, expect, it } from "vitest";
import { versionProblems } from "./releaseVersion";

const files = (pkg: string, toml: string, lock: string) => ({
  packageJson: JSON.stringify({ name: "action0-mail-client", version: pkg }),
  cargoToml: `[package]\nname = "action0"\nversion = "${toml}"\n\n[lib]\nname = "action0_lib"\n\n[dependencies]\nserde = { version = "1" }\n`,
  cargoLock: `[[package]]\nname = "aes"\nversion = "0.8.4"\n\n[[package]]\nname = "action0"\nversion = "${lock}"\ndependencies = []\n`,
});

describe("release versions", () => {
  it("accepts a tag that matches every version", () => {
    expect(versionProblems("v0.2.0", files("0.2.0", "0.2.0", "0.2.0"))).toEqual(
      [],
    );
    expect(
      versionProblems(
        "v1.0.0-beta.1",
        files("1.0.0-beta.1", "1.0.0-beta.1", "1.0.0-beta.1"),
      ),
    ).toEqual([]);
  });

  it("names each file whose version differs", () => {
    expect(versionProblems("v0.2.0", files("0.2.0", "0.1.0", "0.1.0"))).toEqual(
      [
        "src-tauri/Cargo.toml says 0.1.0, but the tag is v0.2.0.",
        "src-tauri/Cargo.lock says 0.1.0, but the tag is v0.2.0.",
      ],
    );
    expect(versionProblems("v0.2.0", files("0.1.9", "0.2.0", "0.2.0"))).toEqual(
      ["package.json says 0.1.9, but the tag is v0.2.0."],
    );
  });

  it("refuses tags that aren't versions", () => {
    expect(versionProblems("latest", files("0.2.0", "0.2.0", "0.2.0"))).toEqual(
      ['The tag "latest" isn\'t a version tag like v1.2.3.'],
    );
  });
});
