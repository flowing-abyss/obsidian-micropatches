import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["main.js", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: ["src/**/*.ts"] })),
  // Keep obsidianmd's own package.json-scoped configs untouched, only rescope the source-linting ones.
  ...obsidianmd.configs.recommended.map((c) =>
    JSON.stringify(c.files ?? "").includes("package.json") ? c : { ...c, files: ["src/**/*.ts"] },
  ),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // We keep the imperative Setting API for now, not the 1.13+ declarative one.
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
    },
  },
  eslintConfigPrettier,
];
