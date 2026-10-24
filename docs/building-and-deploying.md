# Building and deploying

action0 comes out of one code base in two forms: a static web app (`dist/`, any static host) and a Tauri desktop app with installers for Linux, Windows and macOS. This document explains what each build does, which settings are baked in at build time, how to host the web app and how the desktop bundles are put together. Setting up the OAuth clients is covered in the [README](../README.md#setting-up-google-sign-in), day-to-day development in [development.md](development.md), and shipping a version in [releasing.md](releasing.md).

- [Web build](#web-build)
- [Hosting the static app](#hosting-the-static-app)
- [Build-time settings](#build-time-settings)
- [Desktop builds](#desktop-builds)
- [Icons](#icons)

## Web build

```sh
npm run build   # tsc -b && vite build
```

1. `tsc -b` typechecks the project references in `tsconfig.json` (`tsconfig.app.json` for `src/`, `tsconfig.node.json` for `vite.config.ts`). Both have `noEmit`; TypeScript only checks, Vite compiles.
2. `vite build` bundles the app into `dist/`.

`dist/` then holds:

| Path            | What it is                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `index.html`    | The app (entry `src/main.tsx`)                                                                                    |
| `redirect.html` | Where Microsoft's sign-in returns to (entry `src/redirect.ts`, from `redirect.html` in the project root)          |
| `assets/`       | Hashed JS and CSS chunks; MSAL, the calendar, the composer, settings and `ical.js` are loaded on demand           |
| `favicon.svg`   | Copied from `public/`                                                                                             |
| `theme.js`      | Copied from `public/`: applies the saved theme before the first paint (a file, so the CSP needs no inline script) |

What `vite.config.ts` adds:

- **Plugins:** `@vitejs/plugin-react`, `@tailwindcss/vite`, and `action0:csp`, which injects the production Content Security Policy as a `<meta http-equiv="Content-Security-Policy">` at the top of `<head>`. It applies to `vite build` only (the dev server needs inline scripts for hot reload) and is skipped when the Tauri CLI builds the desktop app (it sets `TAURI_ENV_PLATFORM`), because the desktop app has its own CSP in `src-tauri/tauri.conf.json`. The directives and their reasons are in [security.md](security.md#app-csp).
- **Two entries:** `build.rolldownOptions.input` lists `index.html` and `redirect.html`.
- **`__APP_VERSION__`:** the `version` from `package.json`, compiled in. The app uses it as the "buster" of the persisted query cache (`src/data/queryClient.ts`), so a new version starts with an empty cache.
- **Fixed port:** `server.port` and `preview.port` are 5173 with `strictPort`, because `http://localhost:5173` is the registered OAuth origin. `npm run preview` serves `dist/` there, so a production build can be tried with real sign-in locally.

`npm run check` runs the build as its last step, after typecheck, lint, format check and tests; CI's `check` job does the same (`.github/workflows/ci.yml`).

## Hosting the static app

There's no server side. Any static host works (GitHub Pages, Netlify, Cloudflare Pages, S3 + CDN, nginx…), with a few conditions:

- **HTTPS.** Google and Microsoft only accept plain `http://` for `localhost`, so a deployment needs an `https://` origin.
- **Serve it at the root of the host name.** The build uses Vite's default `base` (`/`), and the MSAL redirect URI is built from it (`redirectUri()` in `src/auth/microsoft/msal.ts`: `<origin>/redirect.html`).
- **No rewrite rules needed.** Routing lives in the URL hash (`src/state/router.ts`), so the only pages are `/` (`index.html`) and `/redirect.html`. Serve `redirect.html` under exactly that address: it's the redirect URI registered in Entra.
- **Caching.** Files in `assets/` have content hashes and can be cached for a long time; `index.html`, `redirect.html` and `theme.js` should be revalidated so a new deployment is picked up on reload.
- **Optional headers.** The CSP comes as a `<meta>` tag, which can't express `frame-ancestors`. If the host can send headers, `frame-ancestors 'self'` keeps other sites from framing the app (not `'none'`: MSAL renews tokens in a hidden frame that loads `redirect.html` from the same origin).

Then register the new origin with the OAuth clients, as described in the README:

- Google: add `https://<your host>` to the web client's **Authorized JavaScript origins** ([Setting up Google sign-in](../README.md#setting-up-google-sign-in)).
- Microsoft: add `https://<your host>/redirect.html` as a **Single-page application** redirect URI ([Setting up Microsoft sign-in](../README.md#setting-up-microsoft-sign-in)).

The client IDs can be built in (next section) or entered by each user in **Add account**, so the same `dist/` works for anyone who brings their own client.

## Build-time settings

`src/app/config.ts` reads four Vite environment variables. Vite takes them from `.env`, `.env.local` (git-ignored; copy `.env.example`) or the process environment, and compiles them into the JavaScript bundle. Values are trimmed; empty counts as unset.

| Variable                            | Used by         | What it is                                                                                                                                |
| ----------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_GOOGLE_CLIENT_ID`             | Web app         | Google OAuth client of type _Web application_                                                                                             |
| `VITE_MICROSOFT_CLIENT_ID`          | Web and desktop | Application (client) ID of the Entra app registration                                                                                     |
| `VITE_GOOGLE_DESKTOP_CLIENT_ID`     | Desktop app     | Google OAuth client of type _Desktop app_                                                                                                 |
| `VITE_GOOGLE_DESKTOP_CLIENT_SECRET` | Desktop app     | That client's secret. Only used together with the ID (`readConfig()` ignores one without the other); Google treats it as not confidential |

None of these is a secret in the usual sense: whatever is set ends up readable in the built app.

**Precedence.** A value from the build always wins over one stored in the browser (`src/app/googleSetup.ts`, `src/app/microsoftSetup.ts`, wired in `src/app/services.ts`):

1. If the build has a client, the **Add account** wizard shows it as set by the build and never writes a browser setting.
2. Otherwise the wizard asks for it, validates it (a Google client ID ends in `.apps.googleusercontent.com` and isn't a `GOCSPX-…` secret; a Microsoft ID is a GUID without the `~` of a secret) and stores it in localStorage under `a0.settings.googleClientId`, `a0.settings.googleDesktopClient` (ID and secret) or `a0.settings.microsoftClientId`.
3. Without either, that provider simply isn't offered until it's set up; the demo accounts always are.

The web app ignores the desktop variables and the desktop app ignores `VITE_GOOGLE_CLIENT_ID` (`createDefaultModules()` in `src/app/services.ts`).

## Desktop builds

```sh
npm run app:build   # tauri build
```

`tauri build` runs `npm run build` first (`build.beforeBuildCommand` in `src-tauri/tauri.conf.json`), compiles the Rust crate in `src-tauri/` with the release profile (`lto`, `opt-level = "s"`, `strip`, one codegen unit), embeds `dist/` (`build.frontendDist`) and bundles installers for the system it runs on into `src-tauri/target/release/bundle/<format>/`. Build each system's installers on that system, or let the [release workflow](releasing.md#the-release-workflow) build all three.

`npm run app:dev` runs the same app against the Vite dev server (`build.devUrl`, started through `beforeDevCommand`).

Android builds are described in [android.md](android.md#building-running-and-debugging): `scripts/android-setup.sh` installs the toolchain into the home folder, `npm run android:build` builds APKs, and the release workflow builds the signed one.

### Prerequisites

- Node.js 22.12 or newer (`engines` in `package.json`; CI uses `.nvmrc`).
- Rust 1.90 or newer (`rust-version` in `src-tauri/Cargo.toml`, edition 2024).
- Linux: WebKitGTK 4.1, librsvg and libayatana-appindicator; the README lists the packages ([Running and building](../README.md#running-and-building)). The release workflow additionally installs `libxdo-dev`, `libssl-dev`, `patchelf` and `xdg-utils` on Ubuntu.
- macOS and Windows: Tauri's [prerequisites](https://v2.tauri.app/start/prerequisites/).

`cargo` commands inside `src-tauri/` (`cargo clippy`, `cargo test`) need `dist/` to exist, because `tauri::generate_context!()` embeds it: run `npm run build` once first. CI's `check` job does it in that order.

### Configuration overlays

`src-tauri/tauri.conf.json` is the base. The Tauri CLI merges the file for the current platform on top of it automatically; the release file is merged only when passed with `--config`.

| File                                | Merged                                       | What it changes                                                                                                                                                                                                                                |
| ----------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/tauri.linux.conf.json`   | On Linux                                     | Bundle targets `appimage`, `deb`, `rpm`                                                                                                                                                                                                        |
| `src-tauri/tauri.macos.conf.json`   | On macOS                                     | Bundle targets `app`, `dmg`                                                                                                                                                                                                                    |
| `src-tauri/tauri.windows.conf.json` | On Windows                                   | Bundle target `nsis` only, with the installer hooks in `src-tauri/windows/hooks.nsh`; and `plugins.deep-link.desktop.schemes` emptied: on Windows action0 doesn't register the `mailto` scheme itself but is offered as a mail app (see below) |
| `src-tauri/tauri.release.conf.json` | `--config src-tauri/tauri.release.conf.json` | `bundle.createUpdaterArtifacts: true`: signed update files next to the installers. Needs the signing key, so local builds leave it out                                                                                                         |

What the base config sets that matters for builds: `productName`/`mainBinaryName` `action0`, `identifier` `app.action0.mail` (also the name of the app's data folders and of its keychain entry), `version` read from `../package.json`, the bundle icons, the `.deb` section `mail`, the `mailto` deep-link scheme and the updater endpoint and public key. The window, CSP and plugins are described in [desktop-app.md](desktop-app.md).

### Bundles per system

| System  | Local command                                                     | Produces                                                                                        |
| ------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Linux   | `npm run app:build`                                               | `bundle/appimage/*.AppImage`, `bundle/deb/*.deb`, `bundle/rpm/*.rpm`                            |
| Windows | `npm run app:build`                                               | `bundle/nsis/*-setup.exe`                                                                       |
| macOS   | `npm run app:build` (this Mac's architecture)                     | `bundle/macos/action0.app`, `bundle/dmg/*.dmg`                                                  |
| macOS   | `npm run app:build -- --target universal-apple-darwin` (as in CI) | The same as a universal binary, under `src-tauri/target/universal-apple-darwin/release/bundle/` |

The universal build needs both Rust targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.

To try a build with update files locally, pass the release overlay and the key in the environment (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`); see [releasing.md](releasing.md#updater-signing-keys-and-secrets).

### Windows installer hooks

Windows never lets an installer make itself the default mail app, so `src-tauri/windows/hooks.nsh` only registers action0 as a mail client that users can then pick in **Settings → Default apps**:

- `NSIS_HOOK_POSTINSTALL` writes, under `SHCTX` (the current user or the machine, depending on the install mode): `Software\Clients\Mail\action0` with its `Capabilities` (name, description, `URLAssociations\mailto = action0.mailto`), an entry in `Software\RegisteredApplications`, and the `action0.mailto` class whose `shell\open\command` is `"$INSTDIR\action0.exe" "%1"`.
- `NSIS_HOOK_POSTUNINSTALL` removes those keys again.

The `mailto:` link then arrives as a command-line argument; [desktop-app.md](desktop-app.md#single-instance-mailto-and-deep-links) explains how it reaches the composer.

## Icons

```sh
npm run app:icon   # tauri icon public/favicon.svg -o src-tauri/icons
```

This regenerates every icon in `src-tauri/icons/` (PNG sizes, `icon.icns`, `icon.ico` and the Windows Store logos) from the web app's `public/favicon.svg`, so the browser tab, the installers and the tray share one source. Run it only when the SVG changes and commit the results; the icons are tracked in git. It also writes the Android app's launcher icons into `src-tauri/gen/android/app/src/main/res/mipmap-*` (and an `ios/` folder into `src-tauri/icons/`, which isn't used yet). The bundle uses the files listed under `bundle.icon` in `src-tauri/tauri.conf.json`, and the tray reuses the window icon (`app.default_window_icon()` in `src-tauri/src/shell.rs`).
