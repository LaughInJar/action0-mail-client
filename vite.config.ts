/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
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
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "connect-src 'self' https://gmail.googleapis.com https://people.googleapis.com https://oauth2.googleapis.com https://accounts.google.com/gsi/",
  "frame-src https://accounts.google.com/gsi/",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Injects the CSP meta tag into `index.html`, for builds only (the dev server needs inline scripts for HMR). */
function contentSecurityPolicy(): Plugin {
  return {
    name: "action0:csp",
    apply: "build",
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
  // The port is part of the OAuth "Authorized JavaScript origin", so it must never drift.
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
