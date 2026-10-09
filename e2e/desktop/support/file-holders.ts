import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type * as Koffi from 'koffi';

// Restart Manager takes the files themselves; this many is far more than an app leaves open.
const MAX_FILES = 1000;
const MAX_LISTED = 20;
// winerror.h; restartmanager.h CCH_RM_SESSION_KEY, CCH_RM_MAX_APP_NAME and CCH_RM_MAX_SVC_NAME.
const ERROR_MORE_DATA = 234;
const SESSION_KEY_CHARS = 33;
const APP_NAME_CHARS = 256;
const SERVICE_NAME_CHARS = 64;

export interface FileHolder {
  readonly pid: number;
  readonly name: string;
}

interface RestartManager {
  startSession(handle: number[], flags: number, key: Buffer): number;
  registerResources(handle: number, count: number, files: string[], apps: number, appList: null, services: number, serviceList: null): number;
  getList(handle: number, needed: number[], count: number[], info: Buffer | null, reasons: number[]): number;
  endSession(handle: number): number;
  infoSize: number;
  decode(info: Buffer, count: number): Array<{ Process: { dwProcessId: number }; strAppName: string }>;
}

let restartManager: RestartManager | undefined;

function bindRestartManager(): RestartManager {
  if (restartManager) return restartManager;
  const koffi = createRequire(__filename)('koffi') as typeof Koffi;
  const lib = koffi.load('rstrtmgr.dll');
  const uniqueProcess = koffi.struct('RM_UNIQUE_PROCESS', { dwProcessId: 'uint32_t', dwLowDateTime: 'uint32_t', dwHighDateTime: 'uint32_t' });
  const processInfo = koffi.struct('RM_PROCESS_INFO', {
    Process: uniqueProcess,
    strAppName: koffi.array('char16_t', APP_NAME_CHARS, 'String'),
    strServiceShortName: koffi.array('char16_t', SERVICE_NAME_CHARS, 'String'),
    ApplicationType: 'int',
    AppStatus: 'uint32_t',
    TSSessionId: 'uint32_t',
    bRestartable: 'int',
  });
  restartManager = {
    startSession: lib.func('uint32_t __stdcall RmStartSession(_Out_ uint32_t *handle, uint32_t flags, void *key)') as RestartManager['startSession'],
    registerResources: lib.func('uint32_t __stdcall RmRegisterResources(uint32_t handle, uint32_t count, const char16_t **files, uint32_t apps, void *appList, uint32_t services, void *serviceList)') as RestartManager['registerResources'],
    getList: lib.func('uint32_t __stdcall RmGetList(uint32_t handle, _Out_ uint32_t *needed, _Inout_ uint32_t *count, void *info, _Out_ uint32_t *reasons)') as RestartManager['getList'],
    endSession: lib.func('uint32_t __stdcall RmEndSession(uint32_t handle)') as RestartManager['endSession'],
    infoSize: koffi.sizeof(processInfo),
    decode: (info, count) => koffi.decode(info, processInfo, count) as ReturnType<RestartManager['decode']>,
  };
  return restartManager;
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  return files;
}

/** The processes Windows' Restart Manager reports holding any of `files` open; none elsewhere. */
export function fileHolders(files: readonly string[]): FileHolder[] {
  if (process.platform !== 'win32' || files.length === 0) return [];
  const rm = bindRestartManager();
  const handle = [0];
  const startError = rm.startSession(handle, 0, Buffer.alloc(SESSION_KEY_CHARS * 2));
  if (startError !== 0) throw new Error(`RmStartSession failed with ${startError}`);
  try {
    const registerError = rm.registerResources(handle[0]!, files.length, [...files], 0, null, 0, null);
    if (registerError !== 0) throw new Error(`RmRegisterResources failed with ${registerError}`);
    const needed = [0];
    const count = [0];
    let listError = rm.getList(handle[0]!, needed, count, null, [0]);
    if (listError === 0) return [];
    if (listError !== ERROR_MORE_DATA) throw new Error(`RmGetList failed with ${listError}`);
    const info = Buffer.alloc(needed[0]! * rm.infoSize);
    count[0] = needed[0]!;
    listError = rm.getList(handle[0]!, needed, count, info, [0]);
    if (listError !== 0) throw new Error(`RmGetList failed with ${listError}`);
    return rm.decode(info, count[0]!).map((entry) => ({ pid: entry.Process.dwProcessId, name: entry.strAppName }));
  } finally {
    rm.endSession(handle[0]!);
  }
}

/** What is left under `root` after a failed delete and, on Windows, which processes hold it, for the teardown error. */
export function describeLeftovers(root: string): string {
  const files = filesUnder(root);
  const lines = [`${files.length >= MAX_FILES ? `${MAX_FILES}+` : files.length} files left under ${root}`];
  for (const file of files.slice(0, MAX_LISTED)) lines.push(`  ${path.relative(root, file)}`);
  if (process.platform !== 'win32') return lines.join('\n');
  try {
    const holders = fileHolders(files);
    lines.push(holders.length === 0 ? 'Restart Manager names no process holding them' : 'held by:');
    for (const holder of holders) lines.push(`  pid ${holder.pid} ${holder.name}`);
  } catch (err) {
    lines.push(`Restart Manager could not be asked: ${err instanceof Error ? err.message : String(err)}`);
  }
  return lines.join('\n');
}
