import { fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  getDesktopDistributionProfile,
  type DesktopDistributionId,
} from "@t3tools/shared/desktopDistribution";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import {
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  type JoinPath,
} from "./DesktopStatePaths.ts";
import { DESKTOP_DISTRIBUTION } from "./DesktopDistribution.ts";

interface EarlyDesktopSettingsInput {
  readonly distribution?: DesktopDistributionId;
  readonly env: NodeJS.ProcessEnv;
  /** The same predicate `DesktopEnvironment` keys the base dir on, so both resolve one path. */
  readonly isPackaged: boolean;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly readFileString: (path: string) => string;
}

type EarlyLinuxElectronOptionsInput = EarlyDesktopSettingsInput;

export interface EarlyLinuxElectronOptions {
  readonly linuxWmClass: string;
  readonly passwordStore: LinuxPasswordStoreSwitch | null;
}

const trimNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const EarlyDesktopSettingsJson = fromLenientJson(
  Schema.Struct({
    linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeEarlyDesktopSettingsJson = Schema.decodeSync(EarlyDesktopSettingsJson);

const isDevelopmentEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  trimNonEmpty(env.VITE_DEV_SERVER_URL) !== null;

function resolveEarlyDesktopSettingsPath(input: {
  readonly distribution?: DesktopDistributionId;
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
}): string {
  const distributionProfile = getDesktopDistributionProfile(
    input.distribution ?? DESKTOP_DISTRIBUTION,
  );
  const t3Home = Option.fromUndefinedOr(input.env.T3CODE_HOME);
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    t3Home,
    // Keyed on packaging exactly as `DesktopEnvironment` keys it: an unpackaged launch is a
    // development one whether or not a dev server is attached, and the two resolvers reading
    // different files for the same launch is the one wrong answer this can give.
    defaultBaseDirName: input.isPackaged ? distributionProfile.defaultBaseDirName : ".t3",
  });
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment: isDevelopmentEnvironment(input.env),
    joinPath: input.joinPath,
    t3Home,
  });
  return input.joinPath(stateDir, "desktop-settings.json");
}

export function resolveEarlyLinuxPasswordStorePreference(
  input: EarlyDesktopSettingsInput,
): LinuxPasswordStorePreference {
  const settingsPath = resolveEarlyDesktopSettingsPath(input);
  try {
    const parsed = decodeEarlyDesktopSettingsJson(input.readFileString(settingsPath));
    return normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore);
  } catch {
    return DEFAULT_LINUX_PASSWORD_STORE;
  }
}

export function resolveEarlyLinuxElectronOptions(
  input: EarlyLinuxElectronOptionsInput,
): EarlyLinuxElectronOptions {
  const preference = resolveEarlyLinuxPasswordStorePreference(input);
  const distributionProfile = getDesktopDistributionProfile(
    input.distribution ?? DESKTOP_DISTRIBUTION,
  );
  return {
    linuxWmClass: isDevelopmentEnvironment(input.env)
      ? "t3code-dev"
      : distributionProfile.linuxWmClass,
    passwordStore: resolveLinuxPasswordStoreSwitch({
      preference,
      env: input.env,
    }),
  };
}
