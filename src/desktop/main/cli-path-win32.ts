// The Windows registry through koffi: the user's Path read raw and written back as REG_EXPAND_SZ, so entries such as
// %USERPROFILE%\bin stay unexpanded, which [Environment]::SetEnvironmentVariable would turn into fixed paths
// (docs/invariants.md "The damocles command"), and the environment keys a new local terminal is built from.

// The value's registry types this file reads and writes.
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const KEY_QUERY_VALUE = 0x0001;
const KEY_SET_VALUE = 0x0002;
const HWND_BROADCAST = 0xffff;
const WM_SETTINGCHANGE = 0x001a;
const SMTO_ABORTIFHUNG = 0x0002;
// how long a running program may take to read the change before the broadcast moves on to the next
const BROADCAST_TIMEOUT_MS = 5000;
// a value another writer grows between the size query and the read is read again, at most this often
const MAX_READ_ATTEMPTS = 4;
// a value name has at most 16,383 characters, plus its terminator
const MAX_VALUE_NAME_CHARS = 16_384;

/** The key where Windows keeps the user's environment, under HKEY_CURRENT_USER. */
export const USER_ENVIRONMENT_KEY = 'Environment';
/** The key where Windows keeps the machine's environment, under HKEY_LOCAL_MACHINE. */
export const MACHINE_ENVIRONMENT_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
export const PATH_VALUE = 'Path';

export type RegistryHive = 'HKCU' | 'HKLM';

export interface PathValue {
  readonly type: 'REG_SZ' | 'REG_EXPAND_SZ';
  readonly data: string;
}

export interface RegistryValue extends PathValue {
  readonly name: string;
}

/** One value of one key under HKEY_CURRENT_USER; koffi binds it, tests replace it. */
export interface PathRegistry {
  // undefined: the value does not exist
  read(): PathValue | undefined;
  // writes data as REG_EXPAND_SZ
  write(data: string): void;
  // deletes the value; nothing when it does not exist
  remove(): void;
}

// An entry as Path compares it: without surrounding spaces or trailing backslashes, ignoring case.
const comparable = (entry: string): string => entry.trim().replace(/\\+$/, '').toLowerCase();

/** Whether two Path entries name the same folder: case-insensitive, a trailing backslash ignored. */
export function sameEntry(first: string, second: string): boolean {
  return comparable(first) !== '' && comparable(first) === comparable(second);
}

/**
 * value with entry appended, or undefined when it already holds it; every other entry stays as written. A value ending in ';'
 * (Windows' default user Path) gets `entry;`, so removing the entry gives the value back byte for byte.
 */
export function withEntry(value: string, entry: string): string | undefined {
  const entries = value.split(';');
  if (entries.some((existing) => sameEntry(existing, entry))) return undefined;
  if (value === '') return entry;
  return value.endsWith(';') ? `${value}${entry};` : `${value};${entry}`;
}

/** value without entry, or undefined when it does not hold it; every other entry stays as written, in order. */
export function withoutEntry(value: string, entry: string): string | undefined {
  const entries = value.split(';');
  const kept = entries.filter((existing) => !sameEntry(existing, entry));
  return kept.length === entries.length ? undefined : kept.join(';');
}

/**
 * Rewrites the value through change, as REG_EXPAND_SZ; false when change leaves it as it is. A missing value reads as '', and
 * a change that leaves '' deletes the value, so a user with no Path before the entry has none after it.
 */
export function changePath(registry: PathRegistry, change: (value: string) => string | undefined): boolean {
  const next = change(registry.read()?.data ?? '');
  if (next === undefined) return false;
  if (next === '') registry.remove();
  else registry.write(next);
  return true;
}

interface KoffiFunction {
  (...args: unknown[]): unknown;
  async: (...args: unknown[]) => void;
}

interface KoffiModule {
  load: (library: string) => { func: (convention: string, name: string, result: string, parameters: string[]) => KoffiFunction };
}

type RegHandle = number | bigint;

interface Advapi32 {
  open: (key: number, subKey: string, options: number, access: number, out: [RegHandle]) => number;
  query: (key: RegHandle, name: string, reserved: null, type: [number], data: Buffer | null, size: [number]) => number;
  enumValue: (key: RegHandle, index: number, name: Buffer, nameChars: [number], reserved: null, type: [number], data: Buffer, size: [number]) => number;
  set: (key: RegHandle, name: string, reserved: number, type: number, data: Buffer, size: number) => number;
  remove: (key: RegHandle, name: string) => number;
  close: (key: RegHandle) => number;
}

let advapi32: Advapi32 | undefined;

// koffi is required lazily, so no other platform loads it.
function koffi(): KoffiModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('koffi') as KoffiModule;
}

function loadAdvapi32(): Advapi32 {
  if (advapi32) return advapi32;
  const library = koffi().load('advapi32.dll');
  advapi32 = {
    open: library.func('__stdcall', 'RegOpenKeyExW', 'long', ['intptr', 'str16', 'uint32', 'uint32', '_Out_ intptr*']) as unknown as Advapi32['open'],
    query: library.func('__stdcall', 'RegQueryValueExW', 'long', ['intptr', 'str16', 'void*', '_Out_ uint32*', 'void*', '_Inout_ uint32*']) as unknown as Advapi32['query'],
    enumValue: library.func('__stdcall', 'RegEnumValueW', 'long', ['intptr', 'uint32', 'void*', '_Inout_ uint32*', 'void*', '_Out_ uint32*', 'void*', '_Inout_ uint32*']) as unknown as Advapi32['enumValue'],
    set: library.func('__stdcall', 'RegSetValueExW', 'long', ['intptr', 'str16', 'uint32', 'uint32', 'void*', 'uint32']) as unknown as Advapi32['set'],
    remove: library.func('__stdcall', 'RegDeleteValueW', 'long', ['intptr', 'str16']) as unknown as Advapi32['remove'],
    close: library.func('__stdcall', 'RegCloseKey', 'long', ['intptr']) as unknown as Advapi32['close'],
  };
  return advapi32;
}

function withKey<T>(hive: RegistryHive, subKey: string, access: number, use: (api: Advapi32, key: RegHandle) => T): T {
  const api = loadAdvapi32();
  const key: [RegHandle] = [0];
  const opened = api.open(hive === 'HKCU' ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE, subKey, 0, access, key);
  if (opened !== ERROR_SUCCESS) throw new Error(`RegOpenKeyExW ${hive}\\${subKey} failed with ${opened}`);
  try {
    return use(api, key[0]);
  } finally {
    api.close(key[0]);
  }
}

// a string value's text: the stored terminator, when the writer stored one, is no part of it
const textOf = (data: Buffer, size: number): string => data.subarray(0, size).toString('utf16le').replace(/\0+$/, '');

/** The value name of HKEY_CURRENT_USER\subKey, read raw and written as REG_EXPAND_SZ; production passes USER_ENVIRONMENT_KEY. */
export function windowsRegistry(subKey: string, name: string = PATH_VALUE): PathRegistry {
  return {
    read: () => withKey('HKCU', subKey, KEY_QUERY_VALUE, (api, key) => {
      for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
        const type: [number] = [0];
        const size: [number] = [0];
        const sized = api.query(key, name, null, type, null, size);
        if (sized === ERROR_FILE_NOT_FOUND) return undefined;
        if (sized !== ERROR_SUCCESS) throw new Error(`RegQueryValueExW ${name} failed with ${sized}`);
        if (type[0] !== REG_SZ && type[0] !== REG_EXPAND_SZ) throw new Error(`HKCU\\${subKey} ${name} has registry type ${type[0]}, not a string`);
        const data = Buffer.alloc(size[0]);
        const read = api.query(key, name, null, type, data, size);
        if (read === ERROR_MORE_DATA) continue;
        if (read !== ERROR_SUCCESS) throw new Error(`RegQueryValueExW ${name} failed with ${read}`);
        return { type: type[0] === REG_EXPAND_SZ ? 'REG_EXPAND_SZ' : 'REG_SZ', data: textOf(data, size[0]) };
      }
      throw new Error(`HKCU\\${subKey} ${name} kept growing while it was read`);
    }),
    write: (data) => withKey('HKCU', subKey, KEY_SET_VALUE, (api, key) => {
      const bytes = Buffer.from(`${data}\0`, 'utf16le');
      const written = api.set(key, name, 0, REG_EXPAND_SZ, bytes, bytes.length);
      if (written !== ERROR_SUCCESS) throw new Error(`RegSetValueExW ${name} failed with ${written}`);
    }),
    remove: () => withKey('HKCU', subKey, KEY_SET_VALUE, (api, key) => {
      const removed = api.remove(key, name);
      if (removed !== ERROR_SUCCESS && removed !== ERROR_FILE_NOT_FOUND) throw new Error(`RegDeleteValueW ${name} failed with ${removed}`);
    }),
  };
}

/** Every string value (REG_SZ and REG_EXPAND_SZ) of hive\subKey, raw and in the key's order; values of other types are left out. */
export function readStringValues(hive: RegistryHive, subKey: string): RegistryValue[] {
  return withKey(hive, subKey, KEY_QUERY_VALUE, (api, key) => {
    const values: RegistryValue[] = [];
    const name = Buffer.alloc(MAX_VALUE_NAME_CHARS * 2);
    let data = Buffer.alloc(4096);
    for (let index = 0, attempts = 0; ;) {
      const nameChars: [number] = [MAX_VALUE_NAME_CHARS];
      const type: [number] = [0];
      const size: [number] = [data.length];
      const result = api.enumValue(key, index, name, nameChars, null, type, data, size);
      if (result === ERROR_NO_MORE_ITEMS) return values;
      if (result === ERROR_MORE_DATA) {
        if (++attempts > MAX_READ_ATTEMPTS) throw new Error(`${hive}\\${subKey} value ${index} kept growing while it was read`);
        data = Buffer.alloc(Math.max(size[0], data.length * 2));
        continue;
      }
      if (result !== ERROR_SUCCESS) throw new Error(`RegEnumValueW ${hive}\\${subKey} failed with ${result}`);
      if (type[0] === REG_SZ || type[0] === REG_EXPAND_SZ) {
        values.push({ name: name.subarray(0, nameChars[0] * 2).toString('utf16le'), type: type[0] === REG_EXPAND_SZ ? 'REG_EXPAND_SZ' : 'REG_SZ', data: textOf(data, size[0]) });
      }
      index++;
      attempts = 0;
    }
  });
}

type SendMessageTimeout = Pick<KoffiFunction, 'async'>;

/**
 * Tells running programs, Explorer included, that the user's environment changed, so a terminal opened next sees the new Path.
 * The call runs on koffi's worker thread: SendMessageTimeoutW waits on each top-level window in turn, up to
 * BROADCAST_TIMEOUT_MS for each slow one, which on main's thread would freeze the window.
 */
export function broadcastEnvironmentChange(send: SendMessageTimeout = koffi().load('user32.dll').func('__stdcall', 'SendMessageTimeoutW', 'intptr', ['intptr', 'uint32', 'uintptr', 'str16', 'uint32', 'uint32', '_Out_ uintptr*'])): Promise<void> {
  return new Promise((resolve, reject) => {
    send.async(HWND_BROADCAST, WM_SETTINGCHANGE, 0, 'Environment', SMTO_ABORTIFHUNG, BROADCAST_TIMEOUT_MS, [0], (err: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
  });
}
