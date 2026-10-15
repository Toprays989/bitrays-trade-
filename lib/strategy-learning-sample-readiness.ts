import {
  nexusRequiredLearningCheckpointMinutes,
} from "./nexus-learning-cycle.ts";

const REJECTED_CONTROL_MINUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function strategyLearningSampleReady(input: {
  sampleMinutes: Iterable<number>;
  rejectedOnly: boolean;
  terminalObservationMinute?: number | null;
}) {
  const minutes = new Set(input.sampleMinutes);
  const required = input.rejectedOnly
    ? REJECTED_CONTROL_MINUTES
    : nexusRequiredLearningCheckpointMinutes(
        input.terminalObservationMinute,
      );
  return required.every((minute) => minutes.has(minute));
}

export function strategyLearningSampleStandard(rejectedOnly: boolean) {
  return rejectedOnly
    ? "REJECTED_CONTROL_1_TO_10"
    : "ACTUAL_ENTRY_1_3_5_15_30_60";
}
