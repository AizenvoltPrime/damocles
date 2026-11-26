// The SSH client path setting: docs/invariants.md "ssh starts with one fixed option set". It is a user setting
// (scope application), so a project's settings never name the program ssh runs as.
import { promises as fs } from 'node:fs';
import { executablePathForm } from '../../../../core/executable-path';
import type { SshClientChoice } from '../../../../core/system-tools';
import type { PrefRefusal } from '../../../preload/overlay-channels';

/** Why a value cannot be the SSH client path, or undefined for one it can be: '' (the default) or an absolute path to a file. */
export async function sshClientPathRefusal(value: string, platform: NodeJS.Platform = process.platform): Promise<PrefRefusal | undefined> {
  if (value === '') return undefined;
  const form = executablePathForm(value, platform);
  if (form.kind !== 'absolute') return 'sshPathNotAbsolute';
  const stat = await fs.stat(form.file).catch(() => undefined);
  return stat?.isFile() === true ? undefined : 'sshPathNotFile';
}

/** The setting's stored value as resolveSshExecutable takes it; resolveSshExecutable checks it again, since the file can go. */
export function sshClientChoice(value: unknown): SshClientChoice {
  return typeof value === 'string' && value !== '' ? { configured: value } : {};
}
