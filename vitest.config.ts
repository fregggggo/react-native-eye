import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Projects live in vitest.workspace.ts. On vitest 2.1 this option takes a
    // path, not an inline array — `projects` is a 3.2 field and does not exist
    // in this version. include/environment above stay as the fallback if the
    // workspace file is ever removed.
    workspace: "./vitest.workspace.ts",
  },
});
