import { describe, it, expect } from "vitest";
import { IosDriver } from "../../src/drivers/ios.js";

/**
 * Tier 3 — the opt-in integration tier.
 *
 * Everything in this directory needs a real booted simulator and is skipped
 * unless RNE_INTEGRATION_UDID names one:
 *
 *   RNE_INTEGRATION_UDID=6A44728B-5714-451E-9814-073FDE003991 npm run test:integration
 *
 * The gate is enforced twice on purpose. vitest.workspace.ts collects no files
 * for the `integration` project when the variable is unset, so a bare
 * `vitest run` never comes here at all; `describe.skipIf` below makes a direct
 * `vitest run test/integration/gate.test.ts` skip rather than fail against a
 * device that is not there.
 *
 * This file is a gate check, not the tier. The tier needs a fixture app whose
 * screens are known — a controlled and an uncontrolled TextInput, a press
 * handler far above the hit host, a long list to scroll, a deeplink to open —
 * and that app is out of scope here and gets its own spec. The wiring lands
 * now anyway, because a tier that is only ever described in a spec does not
 * get built; one that exists and is empty does.
 */
const udid = process.env.RNE_INTEGRATION_UDID;

describe.skipIf(!udid)("integration gate", () => {
  it("finds RNE_INTEGRATION_UDID among the simulators simctl lists", async () => {
    const devices = await new IosDriver().listDevices();
    const listed = devices
      .map((d) => `${d.udid} (${d.name}${d.booted ? ", booted" : ""})`)
      .join("\n  ");
    const match = devices.find((d) => d.udid === udid);
    expect(
      match,
      `RNE_INTEGRATION_UDID=${udid} is not a simulator simctl knows about. Available:\n  ${listed}`,
    ).toBeDefined();
    expect(
      match!.booted,
      `Simulator ${udid} (${match?.name}) is not booted; boot it with: xcrun simctl boot ${udid}`,
    ).toBe(true);
  });
});
