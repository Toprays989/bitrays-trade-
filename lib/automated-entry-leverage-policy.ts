export const AUTOMATED_ENTRY_MIN_CONTRACT_MAX_LEVERAGE = 5;

export type AutomatedEntryLeverageDecision = {
  allowed: boolean;
  code: "ALLOWED" | "CONTRACT_MAX_LEVERAGE_TOO_LOW" | "CONTRACT_LEVERAGE_UNKNOWN";
  contractMaximumLeverage: number | null;
  minimumRequiredLeverage: number;
};

/**
 * This policy uses the instrument's Binance leverage bracket only. The
 * account's currently selected leverage is a separate execution concern.
 * A configured entry is eligible only when Binance reports that the contract
 * can support the leverage requested by that immutable strategy version.
 */
export function evaluateAutomatedEntryContractLeverage(
  contractMaximumLeverage: unknown,
  requestedLeverage: unknown = AUTOMATED_ENTRY_MIN_CONTRACT_MAX_LEVERAGE,
): AutomatedEntryLeverageDecision {
  const requested = Number(requestedLeverage);
  const minimumRequiredLeverage = Number.isInteger(requested) && requested >= 1
    ? requested
    : AUTOMATED_ENTRY_MIN_CONTRACT_MAX_LEVERAGE;
  const value = Number(contractMaximumLeverage);
  if (!Number.isFinite(value) || value < 1)
    return {
      allowed: false,
      code: "CONTRACT_LEVERAGE_UNKNOWN",
      contractMaximumLeverage: null,
      minimumRequiredLeverage,
    };
  if (value < minimumRequiredLeverage)
    return {
      allowed: false,
      code: "CONTRACT_MAX_LEVERAGE_TOO_LOW",
      contractMaximumLeverage: value,
      minimumRequiredLeverage,
    };
  return {
    allowed: true,
    code: "ALLOWED",
    contractMaximumLeverage: value,
    minimumRequiredLeverage,
  };
}
