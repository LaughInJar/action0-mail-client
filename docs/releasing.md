# Releasing

A desktop release is a version tag: pushing `v<version>` makes GitHub Actions build installers for Linux, Windows and macOS into a draft GitHub Release, together with the signed `latest.json` that installed apps read to update themselves. The web app has no release process of its own; a new version is a new `dist/` on the host. This document walks through both, the signing keys behind updates, and what to do when a release goes wrong. The short version is in the [README](../README.md#releases); how the builds themselves work is in [building-and-deploying.md](building-and-deploying.md).

- [Versioning](#versioning)
- [The release workflow](#the-release-workflow)
- [Updater signing keys and secrets](#updater-signing-keys-and-secrets)
- [latest.json and how installed apps update](#latestjson-and-how-installed-apps-update)
- [Code-signing status](#code-signing-status)
- [Release checklist](#release-checklist)
- [Releasing the web app](#releasing-the-web-app)
- [When something goes wrong](#when-something-goes-wrong)

## Versioning

`version` in `package.json` is the source of truth:

| Where                       | How it gets the version                                                   | What uses it                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`              | Set by hand (or `npm version`)                                            | Everything below                                                                                                                  |
| `package-lock.json`         | Repeats it in its root entries                                            | `npm ci`                                                                                                                          |
| `src-tauri/tauri.conf.json` | `"version": "../package.json"`                                            | The app's version: Settings → App (`shell_info`), the updater's comparison, the installers' file names                            |
| `vite.config.ts`            | Reads `package.json` into `__APP_VERSION__`                               | The persisted query cache's buster (`src/data/queryClient.ts`): a new version starts with an empty cache                          |
| `src-tauri/Cargo.toml`      | Its own `version` (currently the same, `0.1.0`), recorded in `Cargo.lock` | Not the app version, but `CARGO_PKG_VERSION` is the `User-Agent` of native requests (`action0/<version>`, `src-tauri/src/net.rs`) |

So a version bump touches three files:

```sh
npm version 0.2.0 --no-git-tag-version      # package.json and package-lock.json
# edit src-tauri/Cargo.toml: version = "0.2.0"
(cd src-tauri && cargo check)               # updates Cargo.lock
```

CI runs `cargo clippy` and `cargo test` with `--locked`, which fails when `Cargo.lock` would have to change, so commit the updated lock file with the bump.

Versions must be valid semver and only go up: the updater installs a release only if its version is greater than the running one (the default comparison of `tauri-plugin-updater`). The tag is `v` plus the version (`v0.2.0`). The release workflow checks that the tag matches all three files before building (`node scripts/check-release.ts v0.2.0` runs the same check locally); the release is named after the tag, while the installers and `latest.json` carry the version from `package.json`.

## The release workflow

`.github/workflows/release.yml`, step by step:

1. **Trigger:** a pushed tag matching `v*`. The workflow has `permissions: contents: write`, so the built-in `GITHUB_TOKEN` can create the release and upload files.
2. **`verify`** (a few seconds): `scripts/check-release.ts` checks that the tag equals the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`, and `git merge-base --is-ancestor` checks that the tagged commit is on `main`. Either failure names the problem in the run's annotations.
3. **`checks`**: CI's `check` job, reused from `.github/workflows/ci.yml` (`workflow_call`): typecheck, lint, format, tests, build, `cargo fmt`, `clippy` and `cargo test`.
4. **Matrix** (`desktop`, only once `verify` and `checks` passed) (`fail-fast: false`, so one failing system doesn't cancel the others; 60-minute timeout each):

   | Runner           | Extra args                        | Why                                                                    |
   | ---------------- | --------------------------------- | ---------------------------------------------------------------------- |
   | `ubuntu-22.04`   | —                                 | The oldest supported Ubuntu, so the AppImage runs on older systems too |
   | `windows-latest` | —                                 |                                                                        |
   | `macos-latest`   | `--target universal-apple-darwin` | One build for Apple silicon and Intel Macs                             |

5. **Setup:** checkout; Node from `.nvmrc` with the npm cache; on Ubuntu the WebKitGTK, AppIndicator, librsvg, libxdo, OpenSSL, `patchelf` and `xdg-utils` packages; stable Rust (on macOS with the `aarch64-apple-darwin` and `x86_64-apple-darwin` targets); `Swatinem/rust-cache` for `src-tauri`; `npm ci`.
6. **Build and upload:** `tauri-apps/tauri-action@v1` runs the Tauri build with `--config src-tauri/tauri.release.conf.json` (plus the matrix args). That build runs `npm run build` first, with the `VITE_*` values from the step's environment compiled in. The action then finds or creates the release for `tagName` (the pushed tag) as a **draft** named `action0 <tag>`, with a fixed body ("Download the installer for your system below. Installed apps update themselves."), not marked as prerelease, and uploads the bundles. With its default settings it also uploads the `.sig` signature files and the updater's `latest.json`.

Nothing is built, and no draft appears, when `verify` or `checks` fails.

What ends up in the draft:

| System  | Installers                  | Update file (with `.sig`)               |
| ------- | --------------------------- | --------------------------------------- |
| Linux   | `.AppImage`, `.deb`, `.rpm` | `.AppImage`                             |
| Windows | NSIS `-setup.exe`           | `-setup.exe`                            |
| macOS   | universal `.dmg`            | `.app.tar.gz` (the `.app` as a tarball) |

plus `latest.json`. `bundle.createUpdaterArtifacts: true` in `src-tauri/tauri.release.conf.json` is what makes Tauri produce the update files and sign them with the key.

Variables and secrets (repository **Settings → Secrets and variables → Actions**):

| Name                                 | Kind     | Required | Purpose                                                                                                                     |
| ------------------------------------ | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Secret   | Yes      | The updater's private key (the key file's content)                                                                          |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret   | Yes      | Its password                                                                                                                |
| `VITE_GOOGLE_DESKTOP_CLIENT_ID`      | Variable | No       | Google "Desktop app" client built into the app; otherwise users enter one in **Add account**                                |
| `VITE_GOOGLE_DESKTOP_CLIENT_SECRET`  | Secret   | No       | That client's secret (stored as a secret, but readable in the built app; Google treats desktop secrets as not confidential) |
| `VITE_MICROSOFT_CLIENT_ID`           | Variable | No       | Entra client ID built into the app                                                                                          |
| `GITHUB_TOKEN`                       | Built-in | —        | Creates the release and uploads the files                                                                                   |

## Updater signing keys and secrets

Updates are signed with a key pair of Tauri's own (minisign), unrelated to OS code signing. Create it once:

```sh
npx tauri signer generate -w ~/.tauri/action0-updater.key
```

It asks for a password and writes the private key to `~/.tauri/action0-updater.key` and the public key to `~/.tauri/action0-updater.key.pub`.

- The **public key** goes into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` (already set). It's compiled into every app, which then accepts only updates signed with the matching private key.
- The **private key** and its password become the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, for example `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/action0-updater.key` (reads the file without printing it).

Never commit the private key or paste it anywhere else, and keep a backup outside the machine (a password manager). Without it, installed apps can't be updated: a new key pair needs a new `pubkey`, which only apps installed by hand from then on will know.

## latest.json and how installed apps update

The updater looks for `latest.json` at the endpoint in `src-tauri/tauri.conf.json`:

```
https://github.com/LaughInJar/action0-mail-client/releases/latest/download/latest.json
```

GitHub's `releases/latest` is the newest **published** release that isn't a prerelease. Drafts don't count, so an update becomes visible to installed apps only when the draft is published.

`latest.json` names the version and, per platform (keys like `linux-x86_64`, `windows-x86_64`, `darwin-aarch64`), the download URL of the update file and its signature. The plugin looks for `<os>-<arch>-<installer>` first, then `<os>-<arch>`.

In the app (`src/platform/desktop/index.ts`, `src/ui/desktop/DesktopIntegration.tsx`):

1. `UpdateBar` calls `desktop.checkForUpdate()` when the app starts and then every 24 hours (`UPDATE_CHECK_MS`). It wraps `check()` from `@tauri-apps/plugin-updater`; any error counts as "no update", so being offline stays silent.
2. If there's a newer version, a bar says so (by version number; release notes aren't shown) with **Install** and **Later**. Nothing installs without that click.
3. **Install** calls `downloadAndInstall()`, which verifies the signature against the built-in public key, then `relaunch()` from `@tauri-apps/plugin-process`. If it fails, the bar shows the error and offers Install again.
4. Settings → App shows the running version and has **Check for updates** (`src/ui/settings/DesktopSettings.tsx`), which goes through the same steps.

The capabilities `updater:default` and `process:allow-restart` (`src-tauri/capabilities/main.json`) allow exactly this.

## Code-signing status

The installers aren't code-signed: there's no signing identity in `src-tauri/tauri.conf.json` and no Apple or Windows signing secrets in the workflow (OS code signing is planned for later, see the decisions log in `CLAUDE.md`). On first start:

- **macOS** Gatekeeper refuses to open an app from an unidentified developer. Users allow it under **System Settings → Privacy & Security** (**Open Anyway**).
- **Windows** SmartScreen shows "Windows protected your PC"; **More info → Run anyway** starts it.

Updates through the updater don't depend on this: they're checked with the updater key above.

## Release checklist

1. `main` is green: CI's `check` job passed for the commit you release, and `npm run check` passes locally.
2. Bump the version (see [Versioning](#versioning)) on a branch, open a pull request, merge it after CI passes.
3. Prepare the notes: what changed since the last tag (`git log v<previous>..main --oneline`). There's no changelog file; the notes go into the release description.
4. Tag the merged commit and push the tag:

   ```sh
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

5. Watch the **Release** workflow: `verify` and `checks` first, then the three builds; all must succeed.
6. Check the draft release: every installer from the table above, a `.sig` next to each update file, and `latest.json` with the right version and an entry for each platform. Replace the generic body with the notes.
7. Try at least the installer for your own system.
8. Publish the draft. From now on `releases/latest/download/latest.json` serves this version.
9. Verify the update: start an installed older version (or use **Check for updates** in Settings → App); it should offer the new version, install it and restart into it.
10. Deploy the web app from the same commit if it changed (next section).

## Releasing the web app

The web app updates whenever the host serves a new `dist/`; browsers get it on the next load. There is no deployment workflow in this repository, so:

1. Build with the deployment's client IDs in the environment (or none, to let users enter their own): `VITE_GOOGLE_CLIENT_ID=… VITE_MICROSOFT_CLIENT_ID=… npm run build`.
2. Upload `dist/` to the static host ([Hosting the static app](building-and-deploying.md#hosting-the-static-app)).

Things to know:

- Bump the version when the shape of cached data changes: the version is the query cache's buster, so the same version keeps the previous build's sessionStorage cache (at most 10 minutes old) after a reload.
- Tabs that stay open keep running the old build. They load some code on demand (composer, calendar, settings, MSAL), so keeping the previous build's `assets/` files on the host for a while lets those tabs still load the chunks they ask for.
- Deploying the web app doesn't touch installed desktop apps; they carry their own copy of `dist/` and change only through a desktop release.

## When something goes wrong

**`verify` or `checks` fails.** Nothing was built. Fix the cause on `main` (usually a version that wasn't bumped everywhere, or a tag on an unmerged commit), then move the tag: delete it as below and tag the right commit again.

**A build job fails.** The other systems keep building (`fail-fast: false`). Fix the cause; if it was a flaky runner, re-run the failed job from the Actions page, and the action uploads into the same draft (it finds the release by tag). If the fix needs a code change, start over as below.

**Wrong artifacts or wrong version in the draft.** Nothing is public yet. Delete the draft release, delete the tag, fix, and tag again:

```sh
git push --delete origin v0.2.0
git tag -d v0.2.0
```

**A bad release was published.** Installed apps only update forward, and those that already updated stay on the bad version until a higher one appears. So:

1. Take it down right away: turn it back into a draft (`gh release edit v0.2.0 --draft`), mark it as a pre-release, or delete it. `releases/latest` then points back to the previous release, and apps that haven't updated yet stop being offered the bad one.
2. Fix the problem and release a higher version (`v0.2.1`). Don't reuse the bad version number: apps that installed it would never update to a release with the same number.

**The signing key is lost or leaked.** Generate a new pair, put the new public key into `src-tauri/tauri.conf.json` and the private key into the secrets. Existing installations can't verify updates signed with the new key; users have to install the next version by hand once.
