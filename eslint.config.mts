import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import obsidianmd from "eslint-plugin-obsidianmd";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

const source = ["src/**/*.ts"];
const tests = ["src/**/*.test.ts"];

export default [
  { ignores: ["main.js", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: source })),
  // Keep obsidianmd's own package.json-scoped configs untouched, only rescope the source-linting ones.
  ...obsidianmd.configs.recommended.map((c) =>
    JSON.stringify(c.files ?? "").includes("package.json") ? c : { ...c, files: source },
  ),
  { ...sonarjs.configs.recommended, files: source },
  {
    files: source,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // No size or complexity budgets: a patch is one register() closure by design.
    rules: {
      "sonarjs/cognitive-complexity": "off",
      // Return types are declared, and a union such as `Mode | null` is often the point.
      "sonarjs/function-return-type": "off",

      "array-callback-return": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-else-return": ["error", { allowElseIf: false }],
      "no-new-wrappers": "error",
      "no-param-reassign": "error",
      "no-throw-literal": "error",
      "object-shorthand": ["error", "always"],
      "prefer-const": ["error", { destructuring: "all", ignoreReadBeforeAssign: false }],
      "prefer-template": "error",
      "require-atomic-updates": "error",

      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-check": false,
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          minimumDescriptionLength: 12,
        },
      ],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true, allowHigherOrderFunctions: true, allowTypedFunctionExpressions: true },
      ],
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: false, ignoreVoidOperator: false },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": ["error", { ignoreIIFE: false, ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: true }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Nullable objects stay allowed: an object is always truthy, so `if (!el)` is unambiguous.
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        { allowString: false, allowNumber: false, allowNullableObject: true },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["src/patches/*.ts"],
    ignores: tests,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./*", "../*", "!../patch"],
              message: "Patches are independent: import only ../patch, and duplicate small helpers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: tests,
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  eslintConfigPrettier,
];
