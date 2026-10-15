export const AUTO_VOLUME_THRESHOLD_USDT = 15_000_000;

export type ContractPoolSource =
  | "MANUAL_INCLUDE"
  | "MANUAL_PROTECT"
  | "AUTO_FILTER"
  | "MANUAL_EXCLUDE"
  | "AUTO_VOLUME_EXCLUDE";

export function resolveContractPoolVolumeMembership(input: {
  currentSource: ContractPoolSource | null;
  quoteVolume24h: number;
}) {
  const currentSource =
    input.currentSource === "MANUAL_PROTECT"
      ? "MANUAL_INCLUDE"
      : input.currentSource;
  const qualifiesForAutomaticAdmission =
    input.quoteVolume24h >= AUTO_VOLUME_THRESHOLD_USDT;
  const source: ContractPoolSource = currentSource === "MANUAL_EXCLUDE"
    ? "MANUAL_EXCLUDE"
    : currentSource === "MANUAL_INCLUDE"
      ? "MANUAL_INCLUDE"
      : qualifiesForAutomaticAdmission
        ? "AUTO_FILTER"
        : "AUTO_VOLUME_EXCLUDE";
  const isActive = source !== "MANUAL_EXCLUDE" && source !== "AUTO_VOLUME_EXCLUDE";
  return { source, isActive };
}
