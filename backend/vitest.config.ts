import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/integration-test-setup.ts"],
  },
});
