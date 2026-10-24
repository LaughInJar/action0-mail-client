import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Module boundaries (see CLAUDE.md): the UI, data and state layers only know
 * the provider-agnostic contracts in `src/core`. Concrete providers and auth
 * implementations are wired up in `src/app` (the composition root).
 */
const providerImplementations = {
  group: [
    "**/providers/**",
    "**/auth/google/**",
    "**/auth/microsoft/**",
    "**/auth/native/**",
  ],
  message:
    "UI, data and state code must use the provider-agnostic contracts in src/core. Wire concrete providers in src/app.",
};

/** Tauri's APIs: only the native platforms (`src/platform/native`: desktop, Android) talk to the native side. */
const tauriApis = {
  group: ["@tauri-apps/*"],
  message:
    "Only src/platform/native uses Tauri; everything else goes through the Platform interface.",
};

/** `no-restricted-syntax` entries that catch interface text outside the catalogue. */
function untranslated() {
  const message =
    "Interface text goes in src/i18n/texts (English and German) and is read with useT().";
  const words = "/[A-Za-z]{2,}/";
  const attributes =
    "/^(aria-label|aria-description|title|placeholder|alt|label|legend|backdropLabel|confirmLabel|hint)$/";
  const properties = "/^(message|title|label|hint|description|confirmLabel)$/";
  // A string, or a template's fixed parts, under `parent`.
  const texts = (parent) => [
    `${parent} > Literal[value=${words}]`,
    `${parent} > TemplateLiteral > TemplateElement[value.raw=${words}]`,
    `${parent} > :matches(ConditionalExpression, LogicalExpression) > Literal[value=${words}]`,
  ];
  return [
    `JSXText[value=${words}]`,
    `JSXAttribute[name.name=${attributes}] > Literal[value=${words}]`,
    ...texts(`JSXAttribute[name.name=${attributes}] > JSXExpressionContainer`),
    ...texts(":matches(JSXElement, JSXFragment) > JSXExpressionContainer"),
    ...texts(`Property[key.name=${properties}]`),
  ].map((selector) => ({ selector, message }));
}

export default defineConfig([
  globalIgnores(["dist", "coverage", "src-tauri"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
      jsxA11y.flatConfigs.strict,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true },
      ],
      // `value || fallback` is intended for empty strings.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true } },
      ],
      eqeqeq: "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: [
      "src/ui/**",
      "src/data/**",
      "src/state/**",
      "src/keyboard/**",
      "src/compose/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [providerImplementations, tauriApis] },
      ],
    },
  },
  {
    files: ["src/**"],
    ignores: [
      "src/platform/native/**",
      "src/ui/**",
      "src/data/**",
      "src/state/**",
      "src/keyboard/**",
      "src/compose/**",
      "src/core/**",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [tauriApis] }],
    },
  },
  {
    // Everything the interface says comes from the catalogue (useT()), so
    // German can't miss a text. Words (2+ letters) in JSX text, in texty
    // attributes and in message-like properties are flagged.
    files: ["src/ui/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...untranslated()],
    },
  },
  {
    files: ["src/core/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "react",
                "react-dom",
                "@tanstack/*",
                "zustand",
                "@tauri-apps/*",
                "../*",
              ],
              message:
                "src/core holds pure contracts and must not depend on anything.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      // Tests may wire up the in-memory provider directly.
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    // Plain scripts served as they are (no bundling).
    files: ["public/**/*.js"],
    languageOptions: { sourceType: "script", globals: globals.browser },
  },
]);
