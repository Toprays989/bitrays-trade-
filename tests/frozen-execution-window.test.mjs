import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FROZEN_EXECUTION_LIFETIME_MS,
  MAX_FROZEN_EXECUTION_RENEWALS,
  renewFrozenExecutionDecision,
} from "../lib/nexus-frozen-execution-window.mjs";

const approvedAt = 1_000_000;

function decision(overrides = {}) {
  return {
    approved: true,
    decisionFrozen: true,
    retryWithoutReanalysis: true,
    approvedAt: new Date(approvedAt).toISOString(),
    executionValidityMs: 60_000,
    executionExpiresAt: new Date(approvedAt + 60_000).toISOString(),
    ...overrides,
  };
}

test("transient execution waits renew the frozen window", () => {
  const result = renewFrozenExecutionDecision({
    frozenDecision: decision(),
    deferredAt: new Date(approvedAt + 61_000),
    waitCode: "PILOT_SYMBOL_RULES_WAIT",
    analysisValiditySeconds: 60,
    allowRenewal: true,
    maxRenewals: MAX_FROZEN_EXECUTION_RENEWALS,
  });

  assert.equal(result.renewed, true);
  assert.equal(result.decision.executionRenewalCount, 1);
  assert.equal(
    result.executionExpiresAtMs,
    approvedAt + 121_000,
  );
});

test("renewal remains bounded by the frozen execution lifetime", () => {
  const result = renewFrozenExecutionDecision({
    frozenDecision: decision(),
    deferredAt: new Date(approvedAt + MAX_FROZEN_EXECUTION_LIFETIME_MS),
    waitCode: "PILOT_SYMBOL_RULES_WAIT",
    analysisValiditySeconds: 60,
    allowRenewal: true,
    maxRenewals: MAX_FROZEN_EXECUTION_RENEWALS,
  });

  assert.equal(result.renewed, true);
  assert.equal(
    result.executionExpiresAtMs,
    approvedAt + MAX_FROZEN_EXECUTION_LIFETIME_MS,
  );
});
