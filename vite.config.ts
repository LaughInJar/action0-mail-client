/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

/**
 * Content Security Policy for the production build.
 *
 * Mail HTML is rendered in `srcdoc` iframes, which inherit this policy. That is
 * why inline styles and https images are allowed here: the per-message CSP
 * inside the iframe is what actually blocks remote content until the user
 * allows it (see `src/security/mailDocument.ts`).
 *
 * `connect-src https:` lets one-click unsubscribe (RFC 8058) reach the
 * sender's server. Remote images may load from anywhere once allowed, so
 * this barely widens what the app can reach.
 *
 * `frame-src` allows Google's sign-in frame and MSAL's hidden renewal
 * iframe, which returns to this site's `redirect.html` ('self').
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "connect-src 'self' https:",
  "frame-src 'self' https://accounts.google.com/gsi/ https://login.microsoftonline.com",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** True when the Tauri CLI builds the desktop app (it sets `TAURI_ENV_*`). */
const desktopBuild = process.env.TAURI_ENV_PLATFORM !== undefined;

/**
 * Injects the CSP meta tag into `index.html`, for builds only (the dev
 * server needs inline scripts for HMR). The desktop app has its own CSP
 * (`src-tauri/tauri.conf.json`), which a meta tag would only narrow.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: "action0:csp",
    apply: (_config, { command }) => command === "build" && !desktopBuild,
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: {
          "http-equiv": "Content-Security-Policy",
          content: PRODUCTION_CSP,
        },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    rolldownOptions: {
      // redirect.html: where Microsoft's sign-in returns to.
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        redirect: fileURLToPath(new URL("redirect.html", import.meta.url)),
      },
    },
  },
  // The port is part of the OAuth "Authorized JavaScript origin", so it must never drift.
  server: {
    port: 5173,
    strictPort: true,
    // The desktop app's Rust code isn't part of the web app.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // `tauri dev` shows its own output too.
  clearScreen: false,
  preview: { port: 5173, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
