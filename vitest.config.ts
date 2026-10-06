import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".autopilot/**"],
    // Hosted Windows runners need less worker contention and more time for protected-state/loopback integration tests.
    ...(process.platform === "win32" ? { maxWorkers: 1, testTimeout: 15_000 } : {})
  }
});
