import type { PermissionResult } from './types';

export function buildFileEditDenyResult(customMessage?: string, defaultMessage?: string): PermissionResult {
  const message = customMessage
    ? `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: ${customMessage}`
    : defaultMessage;
  return {
    behavior: 'deny',
    ...(message !== undefined && { message }),
  };
}

export function buildDenyResult(customMessage?: string, defaultMessage?: string): PermissionResult {
  const message = customMessage
    ? `The user doesn't want to proceed with this tool use. The tool use was rejected. The user provided the following reason for the rejection: ${customMessage}`
    : defaultMessage;
  return {
    behavior: 'deny',
    ...(message !== undefined && { message }),
  };
}

export function buildDenyResultWithInterrupt(customMessage?: string, defaultMessage?: string): PermissionResult {
  const message = customMessage
    ? `The user doesn't want to proceed with this tool use. The tool use was rejected. The user provided the following reason for the rejection: ${customMessage}`
    : defaultMessage;
  return {
    behavior: 'deny',
    ...(message !== undefined && { message }),
    interrupt: !customMessage,
  };
}

export function buildAllowResult(input: unknown): PermissionResult {
  return { behavior: 'allow', updatedInput: input };
}
