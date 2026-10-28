// Real shells for the stage tests: a POSIX sh (Git for Windows' sh on Windows) and PowerShell (Windows PowerShell 5.1 on
// Windows, pwsh elsewhere when installed). Scripts run from files, so no argument quoting sits between a test and the shell.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';
import { processLauncher, runProcess, type RunOutput, type SpawnSpec } from '../../../../../core/process-launcher';
import { findBash, findPwsh, windowsPowerShell } from '../../../../../core/system-tools';
import { parseStageLine, type StageMessage } from '../probe-parse';
import { WINDOWS_STDIO_SETUP } from '../stage0';
import POSIX_STAGE1 from '../stage1-posix.sh';
import WINDOWS_STAGE1 from '../stage1-windows.ps1';
import { stageDefinitions } from '../stage1';

/**
 * Runs a process with these exact stdin bytes, then closes stdin; runProcess writes a string input as UTF-8. With `paced`,
 * each later part goes in 64 KiB chunks a few ms apart, as a network delivers it, so the child's reads find an empty pipe.
 */
export async function runWithBytes(spec: SpawnSpec, input: Buffer, paced?: readonly Buffer[]): Promise<RunOutput> {
  const child = processLauncher().launch(spec);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.onData('stdout', (chunk) => stdout.push(chunk));
  child.onData('stderr', (chunk) => stderr.push(chunk));
  await child.write(input);
  for (const part of paced ?? []) {
    for (let at = 0; at < part.length; at += 64 * 1024) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await child.write(part.subarray(at, at + 64 * 1024));
    }
  }
  child.end();
  const exit = await child.exited;
  await child.closed;
  return { exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

export async function posixShell(): Promise<string> {
  if (process.platform !== 'win32') return '/bin/sh';
  const bash = await findBash();
  if (bash === undefined) throw new Error('The stage tests need Git for Windows, whose sh runs the POSIX stage');
  return path.join(path.dirname(bash), 'sh.exe');
}

export async function powerShell(): Promise<string | undefined> {
  return process.platform === 'win32' ? windowsPowerShell() : findPwsh();
}

/** A path as both shells read it: forward slashes, which Git for Windows' sh and PowerShell accept. */
export const shellPath = (file: string): string => file.split(path.sep).join('/');

// every folder a test file made, removed once its tests ran
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function scriptFile(text: string, extension: string): string {
  const file = path.join(scratchDir('stage-script-'), `script${extension}`);
  writeFileSync(file, text);
  return file;
}

export async function runSh(script: string, input?: string): Promise<RunOutput> {
  const sh = await posixShell();
  return runProcess({ file: sh, args: [shellPath(scriptFile(script, '.sh'))], windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, { timeoutMs: 60_000, ...(input !== undefined ? { input } : {}) });
}

// PowerShell 5.1 reads a script file without a BOM in the ANSI code page, so the file starts with one. It gets no PSModulePath
// and builds its default, unless psModulePath names one: the one PowerShell 7 sets, when the tests run under it, names modules
// 5.1 cannot load.
export async function runPowerShell(shell: string, script: string, input?: string, options: { readonly psModulePath?: string } = {}): Promise<RunOutput> {
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  if (options.psModulePath !== undefined) env['PSModulePath'] = options.psModulePath;
  return runProcess(
    { file: shell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile(`\uFEFF${script}`, '.ps1')], env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    { timeoutMs: 120_000, ...(input !== undefined ? { input } : {}) },
  );
}

/** POSIX stage 1's definitions, then `body`, which calls them. */
export function withPosixDefinitions(body: string): string {
  return `${stageDefinitions(POSIX_STAGE1)}\n${body}\n`;
}

// pwsh off Windows has no kernel32, so there stage 1 gets the console streams
const STDIO_SETUP = process.platform === 'win32' ? WINDOWS_STDIO_SETUP : ['$DamoclesIn = [Console]::OpenStandardInput()', '$DamoclesOut = [Console]::OpenStandardOutput()'];

/** Windows stage 1's definitions with the stdin and stdout streams stage 0 opens, then `body`. */
export function withWindowsDefinitions(body: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...STDIO_SETUP,
    stageDefinitions(WINDOWS_STAGE1),
    body,
    '',
  ].join('\n');
}

/** The stage messages on stdout, in order; lines without the marker are left out. */
export function stageMessages(output: RunOutput): StageMessage[] {
  return output.stdout.toString('utf8').split(/\r?\n/).flatMap((line) => {
    const message = parseStageLine(line);
    return message ? [message] : [];
  });
}
