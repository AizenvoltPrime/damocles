/** The reason tokens core emits for a skipped or failed consolidation phase, by i18n key; any other reason is an error's own text. */
const REASON_KEYS: Readonly<Record<string, string>> = {
  'auto-extract-off': 'consolidation.stepper.reason.autoExtractOff',
  'no-queued-turns': 'consolidation.stepper.reason.noQueuedTurns',
  unanswered: 'consolidation.stepper.reason.unanswered',
  rejected: 'consolidation.stepper.reason.rejected',
  'invalid-shape': 'consolidation.stepper.reason.invalidShape',
  unreachable: 'consolidation.stepper.reason.unreachable',
  credential: 'consolidation.stepper.reason.credential',
  'no-model': 'consolidation.stepper.reason.noModel',
};

export function consolidationReasonKey(reason: string): string | undefined {
  return Object.hasOwn(REASON_KEYS, reason) ? REASON_KEYS[reason] : undefined;
}
