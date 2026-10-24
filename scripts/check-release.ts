// Checks that a release tag matches the app's versions; run by the release
// workflow: `node scripts/check-release.ts v1.2.3`.
import { readFileSync } from "node:fs";
import { versionProblems } from "./releaseVersion.ts";

const tag = process.argv[2] ?? "";
const read = (path: string) => readFileSync(path, "utf8");
const problems = versionProblems(tag, {
  packageJson: read("package.json"),
  cargoToml: read("src-tauri/Cargo.toml"),
  cargoLock: read("src-tauri/Cargo.lock"),
});
for (const problem of problems) process.stdout.write(`::error::${problem}\n`);
if (problems.length > 0) process.exit(1);
process.stdout.write(`${tag} matches every version.\n`);
