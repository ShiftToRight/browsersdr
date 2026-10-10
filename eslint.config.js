import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/wasm/pkg/**",
      "src/vendor/adi-no-os/**",
      "wasm/**/target/**",
      "BrowserSDR/**",
      "docs/**",
      "visualizations/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".local/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["deploy/report-service/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      "src/**/*.{ts,tsx}",
      "e2e/**/*.ts",
      "vite.config.ts",
      "vitest.config.ts",
      "playwright.config.ts",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
);
