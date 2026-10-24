/** The files whose versions a release tag must match. */
export interface VersionFiles {
  readonly packageJson: string;
  readonly cargoToml: string;
  readonly cargoLock: string;
}

/** `version` of the `[package]` table of a Cargo.toml. */
function cargoVersion(toml: string): string | undefined {
  const table = /^\[package\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(
    toml,
  )?.[1];
  return table && /^version\s*=\s*"([^"]+)"/m.exec(table)?.[1];
}

/** Version of the `action0` package in a Cargo.lock. */
function lockVersion(lock: string): string | undefined {
  return /\[\[package\]\]\s*name = "action0"\s*version = "([^"]+)"/.exec(
    lock,
  )?.[1];
}

/**
 * What's wrong with releasing `tag` (e.g. "v0.2.0"): one line per problem,
 * none when the tag and every version agree.
 */
export function versionProblems(tag: string, files: VersionFiles): string[] {
  const version = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(tag)?.[1];
  if (version === undefined)
    return [`The tag "${tag}" isn't a version tag like v1.2.3.`];
  const found: readonly (readonly [string, string | undefined])[] = [
    [
      "package.json",
      (JSON.parse(files.packageJson) as { version?: string }).version,
    ],
    ["src-tauri/Cargo.toml", cargoVersion(files.cargoToml)],
    ["src-tauri/Cargo.lock", lockVersion(files.cargoLock)],
  ];
  return found.flatMap(([file, value]) => {
    if (value === undefined) return [`${file} has no version.`];
    return value === version
      ? []
      : [`${file} says ${value}, but the tag is ${tag}.`];
  });
}
