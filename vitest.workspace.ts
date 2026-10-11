import { defineWorkspace } from "vitest/config";

/**
 * Two tiers, one runner.
 *
 * `unit` is the suite that runs on every `vitest run` — unchanged by the split
 * except that the reporter now prefixes each file with `|unit|`.
 *
 * `integration` drives a real booted simulator or emulator, so it collects no files at all
 * unless RNE_INTEGRATION_UDID names a simulator or
 * RNE_INTEGRATION_ANDROID_SERIAL names an Android device. The gate is deliberately at
 * collection time rather than inside the tests: a bare `vitest run` must not
 * even mention this tier.
 *
 * This project is pinned to vitest 2.1.9, which has no `projects` config field
 * (that arrived in 3.2) — `defineWorkspace` is the API this version supports,
 * and `vitest.config.ts` points at this file explicitly instead of relying on
 * auto-discovery.
 *
 * `fileParallelism` cannot be set per project in vitest 2 (it is one of the
 * root-only options), so when this tier grows past one file and the simulator
 * becomes a contended resource, pass `--no-file-parallelism` in the
 * `test:integration` script rather than trying to set it here.
 */
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["test/**/*.test.ts"],
      exclude: ["test/integration/**", "**/node_modules/**"],
      environment: "node",
      // The default pool of every IosDriver a test builds is sharedPool(), which
      // would install and launch the real runner on whatever simulator is
      // booted. Off here; tests of the runner branch inject their own pool, and
      // the integration project (below) leaves it on.
      env: { RNE_NATIVE_DRIVER: "off" },
    },
  },
  {
    test: {
      name: "integration",
      include:
        process.env.RNE_INTEGRATION_UDID || process.env.RNE_INTEGRATION_ANDROID_SERIAL
          ? ["test/integration/**/*.test.ts"]
          : [],
      environment: "node",
      // A single tap against a hot RN app was measured at 17-25s; the point of
      // this tier is to exercise the real thing, so the 5s unit default is
      // useless here.
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
]);
