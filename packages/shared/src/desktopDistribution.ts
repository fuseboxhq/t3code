export const DESKTOP_DISTRIBUTION_IDS = ["official", "fork"] as const;

export type DesktopDistributionId = (typeof DESKTOP_DISTRIBUTION_IDS)[number];

export interface DesktopDistributionProfile {
  readonly id: DesktopDistributionId;
  readonly appId: string;
  readonly productName: string;
  readonly baseName: string;
  readonly protocolScheme: string;
  readonly packagedProtocolSchemes: ReadonlyArray<string>;
  readonly userDataDirName: string;
  readonly legacyUserDataDirName: string;
  readonly defaultBaseDirName: string;
  readonly artifactNamePrefix: string;
  readonly packageName: string;
  readonly linuxExecutableName: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  readonly useDevelopmentBrandAssets: boolean;
  readonly allowsAutomaticUpdates: boolean;
}

export const DESKTOP_DISTRIBUTION_PROFILES = {
  official: {
    id: "official",
    appId: "com.t3tools.t3code",
    productName: "T3 Code (Alpha)",
    baseName: "T3 Code",
    protocolScheme: "t3code",
    packagedProtocolSchemes: ["t3code", "t3code-dev"],
    userDataDirName: "t3code",
    legacyUserDataDirName: "T3 Code (Alpha)",
    defaultBaseDirName: ".t3",
    artifactNamePrefix: "T3-Code",
    packageName: "t3code",
    linuxExecutableName: "t3code",
    linuxDesktopEntryName: "t3code.desktop",
    linuxWmClass: "t3code",
    useDevelopmentBrandAssets: false,
    allowsAutomaticUpdates: true,
  },
  fork: {
    id: "fork",
    appId: "com.fuseboxhq.t3code.fork",
    productName: "T3 Code Fork",
    baseName: "T3 Code Fork",
    protocolScheme: "t3code-fork",
    packagedProtocolSchemes: ["t3code-fork"],
    userDataDirName: "t3code-fork",
    legacyUserDataDirName: "t3code-fork",
    defaultBaseDirName: ".t3-fork",
    artifactNamePrefix: "T3-Code-Fork",
    packageName: "t3code-fork",
    linuxExecutableName: "t3code-fork",
    linuxDesktopEntryName: "t3code-fork.desktop",
    linuxWmClass: "t3code-fork",
    useDevelopmentBrandAssets: true,
    allowsAutomaticUpdates: false,
  },
} as const satisfies Record<DesktopDistributionId, DesktopDistributionProfile>;

export function parseDesktopDistributionId(value: string | undefined): DesktopDistributionId {
  const normalized = value?.trim().toLowerCase() || "official";
  if (normalized === "official" || normalized === "fork") {
    return normalized;
  }
  throw new Error(`Unsupported desktop distribution: ${value ?? ""}`);
}

export function getDesktopDistributionProfile(
  distribution: DesktopDistributionId,
): DesktopDistributionProfile {
  return DESKTOP_DISTRIBUTION_PROFILES[distribution];
}
