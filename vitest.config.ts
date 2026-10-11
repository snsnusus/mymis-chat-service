import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Hide console output from tests that pass; show it for tests that fail,
    // where the service's logs help explain what went wrong.
    silent: "passed-only",
  },
});
