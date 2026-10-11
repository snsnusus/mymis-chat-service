// @ts-check

import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import globals from "globals";

// "Flat config": the config is a plain array of objects, applied top to bottom.
// Later objects override earlier ones for the files they match.
export default defineConfig(
  // 1. Folders ESLint should never look at (build output, deps, coverage reports).
  {
    ignores: ["dist/", "node_modules/", "coverage/"],
  },

  // 2. ESLint's own recommended JavaScript rules.
  eslint.configs.recommended,

  // 3. typescript-eslint's recommended rules that USE type information
  //    (e.g. no-floating-promises, no-misused-promises, no-unsafe-assignment).
  tseslint.configs.recommendedTypeChecked,

  // 4. Style rules that also use types (e.g. prefer `??` over `||` for defaults).
  tseslint.configs.stylisticTypeChecked,

  // 5. Tell typescript-eslint how to find type information.
  {
    languageOptions: {
      parserOptions: {
        // projectService: for each file, find the nearest tsconfig.json automatically.
        projectService: true,
        // The folder that tsconfig paths are relative to: the folder this file is in.
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // 6. Plain .js files (this config, scripts/*.js) aren't part of tsconfig's "include":
  //    turn type-aware rules off for them, and tell ESLint they run in Node
  //    so built-ins like process and console aren't reported as undefined.
  {
    files: ["**/*.js", "vitest.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },

  // 7. Our own additions on top of the presets.
  {
    rules: {
      // Always === / !==, never == / != (which do surprising type conversions: 0 == '' is true).
      eqeqeq: ["error", "always"],
    },
  },
);
