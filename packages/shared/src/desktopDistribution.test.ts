import { assert, describe, it } from "@effect/vitest";

import {
  getDesktopDistributionProfile,
  parseDesktopDistributionId,
} from "./desktopDistribution.ts";

describe("desktopDistribution", () => {
  it("defaults to the official distribution", () => {
    assert.equal(parseDesktopDistributionId(undefined), "official");
    assert.equal(parseDesktopDistributionId("  "), "official");
  });

  it("resolves an isolated fork identity", () => {
    const profile = getDesktopDistributionProfile(parseDesktopDistributionId(" FORK "));

    assert.equal(profile.appId, "com.fuseboxhq.t3code.fork");
    assert.equal(profile.protocolScheme, "t3code-fork");
    assert.equal(profile.defaultBaseDirName, ".t3-fork");
    assert.equal(profile.userDataDirName, "t3code-fork");
    assert.isFalse(profile.allowsAutomaticUpdates);
  });

  it("rejects unknown distributions", () => {
    assert.throws(() => parseDesktopDistributionId("nightly"), /Unsupported desktop distribution/u);
  });
});
