import { parseDesktopDistributionId } from "@t3tools/shared/desktopDistribution";

declare const __T3CODE_DESKTOP_DISTRIBUTION__: string | undefined;

const embeddedDistribution =
  typeof __T3CODE_DESKTOP_DISTRIBUTION__ === "undefined"
    ? undefined
    : __T3CODE_DESKTOP_DISTRIBUTION__;

export const DESKTOP_DISTRIBUTION = parseDesktopDistributionId(embeddedDistribution);
