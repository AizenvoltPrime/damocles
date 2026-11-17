// QueryDosDeviceW through koffi, required lazily behind the win32 check (docs/invariants.md "koffi is required lazily").

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INSUFFICIENT_BUFFER = 122;
// A device target is a UNICODE_STRING of at most 32767 characters, so this many always hold one with its terminators.
const MAX_TARGET_CHARACTERS = 65536;

interface KoffiModule {
  load: (library: string) => { func: (convention: string, name: string, result: string, parameters: unknown[]) => unknown };
}

interface DosDeviceApi {
  // Win32 QueryDosDeviceW: the characters written, 0 on failure
  queryDosDevice: (name: string, buffer: Buffer, length: number) => number;
  // koffi keeps the thread's last error from Node and V8 between its calls
  getLastError: () => number;
}

let api: DosDeviceApi | undefined;

// A load failure throws to the caller and is retried by the next call, never read as an answer.
function dosDeviceApi(): DosDeviceApi {
  if (api !== undefined) return api;
  if (process.platform !== 'win32') throw new Error('QueryDosDeviceW exists only on Windows');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kernel32 = (require('koffi') as KoffiModule).load('kernel32.dll');
  api = {
    queryDosDevice: kernel32.func('__stdcall', 'QueryDosDeviceW', 'uint32', ['str16', 'void*', 'uint32']) as DosDeviceApi['queryDosDevice'],
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint32', []) as DosDeviceApi['getLastError'],
  };
  return api;
}

/**
 * The object-manager target Windows maps the DOS device `name` (a drive, `Z:`) to in this process's logon session, the first of
 * its targets; undefined when no device has that name. Asked at every call, never cached. Throws with the Win32 error code when
 * koffi does not load or the call fails.
 */
export function queryDosDevice(name: string): string | undefined {
  const { queryDosDevice: query, getLastError } = dosDeviceApi();
  for (let length = 1024; ; length *= 2) {
    const buffer = Buffer.alloc(length * 2);
    const written = query(name, buffer, length);
    if (written > 0) return buffer.toString('utf16le', 0, written * 2).split('\0', 1)[0];
    const code = getLastError();
    if (code === ERROR_FILE_NOT_FOUND) return undefined;
    if (code !== ERROR_INSUFFICIENT_BUFFER || length >= MAX_TARGET_CHARACTERS) throw new Error(`QueryDosDeviceW(${name}) failed with Win32 error ${code}`);
  }
}
