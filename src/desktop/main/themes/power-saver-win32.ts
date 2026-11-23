// Windows battery saver, which pauses moving wallpapers (docs/invariants.md "Desktop themes"): Electron reports no such state,
// so main reads GetSystemPowerStatus's SystemStatusFlag through koffi on its theme tick. macOS Low Power Mode and Linux power
// profiles have no call to read, and the on-battery pause covers them.

// SYSTEM_POWER_STATUS: ACLineStatus, BatteryFlag, BatteryLifePercent and SystemStatusFlag bytes, then two DWORDs
const SYSTEM_POWER_STATUS_BYTES = 12;
const SYSTEM_STATUS_FLAG_OFFSET = 3;
// SystemStatusFlag while battery saver is on
const BATTERY_SAVER_ON = 1;

export interface KoffiModule {
  load: (library: string) => { func: (convention: string, name: string, result: string, parameters: string[]) => unknown };
}

type GetSystemPowerStatus = (status: Buffer) => number;

// koffi is required lazily, so no other platform loads it.
function koffi(): KoffiModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('koffi') as KoffiModule;
}

// null: koffi or kernel32 could not be bound, which is reported once and not tried again in this run
let bound: GetSystemPowerStatus | null | undefined;

/**
 * Whether Windows battery saver is on now; undefined off Windows, or when kernel32 cannot be bound or the call fails, which the
 * caller reads as off. `load` is koffi itself; tests pass their own.
 */
export function batterySaverOn(platform: NodeJS.Platform = process.platform, load: () => KoffiModule = koffi, log?: (line: string) => void): boolean | undefined {
  if (platform !== 'win32' || bound === null) return undefined;
  if (bound === undefined) {
    try {
      bound = load().load('kernel32.dll').func('__stdcall', 'GetSystemPowerStatus', 'int', ['void *']) as GetSystemPowerStatus;
    } catch (err) {
      bound = null;
      log?.(`[themes] Windows battery saver cannot be read, so it never pauses moving wallpapers in this run: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
  try {
    const status = Buffer.alloc(SYSTEM_POWER_STATUS_BYTES);
    if (bound(status) === 0) return undefined;
    return status[SYSTEM_STATUS_FLAG_OFFSET] === BATTERY_SAVER_ON;
  } catch {
    return undefined;
  }
}

/** Forgets the bound call; tests bind their own koffi each. */
export function resetBatterySaverBinding(): void {
  bound = undefined;
}
