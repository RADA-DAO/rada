import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const strict = {
  extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
  languageOptions: { parserOptions: { projectService: true } },
  rules: {
    eqeqeq: ["error", "always"],
    "no-console": ["error", { allow: ["warn", "error"] }],
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": "error",
    "@typescript-eslint/no-floating-promises": "error",
  },
};

export default defineConfig(
  {
    ignores: [
      "node_modules/**",
      "apps/miniapp/dist/**",
      "apps/api/src/**",
      "modules/*/api/**",
      "modules/*/index.ts",
    ],
  },
  {
    ...strict,
    files: [
      "tools/**/*.mjs",
      "packages/*/scripts/**/*.{mjs,ts}",
      "packages/*/src/**/*.test.ts",
      "apps/miniapp/tests/**/*.ts",
      "apps/miniapp/*config.ts",
      "modules/**/*.ts",
    ],
    languageOptions: { ...strict.languageOptions, globals: globals.node },
  },
  {
    ...strict,
    files: ["packages/*/src/**/*.ts", "apps/miniapp/src/**/*.ts"],
    ignores: ["packages/*/src/**/*.test.ts"],
    languageOptions: { ...strict.languageOptions, globals: globals.browser },
  },
  {
    files: ["tools/**/*.mjs"],
    rules: { "no-console": "off" },
  },
);
