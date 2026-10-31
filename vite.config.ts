/// <reference types="vitest/config" />
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
 * this barely widens what the app can reach. `http://localhost` and
 * `127.0.0.1` (any port) are the AI assistant's local servers (Ollama,
 * LM Studio), which run on the user's own computer.
 *
 * `frame-src` allows Google's sign-in frame and MSAL's hidden renewal
 * iframe, which returns to this site's `redirect.html` ('self').
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "frame-src 'self' https://accounts.google.com/gsi/ https://login.microsoftonline.com",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "object-src 'none'",
  // The service worker and the manifest (the installable web app).
  "worker-src 'self'",
  "manifest-src 'self'",
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

/** Every file in `public/`, as a site path ("/icons/icon-192.png"). */
function publicFiles(): string[] {
  const root = fileURLToPath(new URL("public", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : [`/${relative(root, join(dir, entry.name)).replaceAll("\\", "/")}`],
    );
  return walk(root);
}

/**
 * The installable web app's service worker (`src/sw/serviceWorker.ts`):
 * built as `/sw.js` (no hash: its address must stay the same), with the
 * list of the app's own files it keeps and a version from their contents
 * filled in. Web builds only; the desktop and Android apps have none.
 */
function serviceWorker(): Plugin {
  return {
    name: "action0:sw",
    apply: (_config, { command }) => command === "build" && !desktopBuild,
    // After the pages are emitted, so `index.html` is in the list.
    enforce: "post",
    config: () => ({
      build: {
        rolldownOptions: {
          input: {
            sw: fileURLToPath(
              new URL("src/sw/serviceWorker.ts", import.meta.url),
            ),
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
          },
        },
      },
    }),
    generateBundle(_options, bundle) {
      const built = Object.values(bundle)
        .map((file) => file.fileName)
        .filter(
          (name) =>
            name !== "sw.js" &&
            name !== "redirect.html" &&
            !name.endsWith(".map"),
        )
        .map((name) => `/${name}`);
      const extra = publicFiles();
      const files = [...built, ...extra].sort();
      const hash = createHash("sha256").update(files.join("\n"));
      for (const path of extra)
        hash.update(
          readFileSync(
            fileURLToPath(new URL(`public${path}`, import.meta.url)),
          ),
        );
      const build = `${version}-${hash.digest("hex").slice(0, 12)}`;
      const worker = bundle["sw.js"];
      if (worker?.type !== "chunk")
        throw new Error("action0:sw: the service worker wasn't built.");
      // A worker is one classic script: it can't load chunks it shares with the page.
      if (worker.imports.length > 0)
        throw new Error(
          `action0:sw: the service worker shares code with the page (${worker.imports.join(", ")}); import only types from src/sw/ in the page.`,
        );
      const list = JSON.stringify(JSON.stringify(files)).slice(1, -1);
      const code = worker.code
        .replace("__A0_FILES__", list)
        .replace("__A0_VERSION__", build);
      if (code.includes("__A0_FILES__") || code.includes("__A0_VERSION__"))
        throw new Error("action0:sw: the placeholders weren't filled in.");
      worker.code = code;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy(), serviceWorker()],
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
