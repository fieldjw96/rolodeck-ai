import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        // `server-only` throws unless it is resolved under React's `react-server` condition,
        // which Vitest does not use. See lib/testing/server-only-stub.ts.
        find: /^server-only$/,
        replacement: fileURLToPath(
          new URL("./lib/testing/server-only-stub.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
