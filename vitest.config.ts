import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // Release/validation snapshots under .local are reference material, not suites.
    include: ["src/**/*.test.{ts,tsx}"],
    maxWorkers: 2,
  },
});
