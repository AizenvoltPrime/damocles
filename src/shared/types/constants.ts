export const FEEDBACK_MARKER = "The user provided the following reason for the rejection:";
export const DEFAULT_THINKING_TOKENS = 63999;

export function isAdaptiveCapable(model: string): boolean {
  return /^claude-(opus|sonnet)-4-6/.test(model);
}
