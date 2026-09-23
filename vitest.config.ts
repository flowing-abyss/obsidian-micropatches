import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `obsidian` ships only types. obsidian-test-mocks/vitest-setup mocks it
    // for tests, but coverage re-transforms sources past vi.mock, so it needs
    // the alias too.
    alias: {
      obsidian: "obsidian-test-mocks/obsidian",
    },
  },
  test: {
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    unstubGlobals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["obsidian-test-mocks/vitest-setup"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "html"],
    },
  },
});
