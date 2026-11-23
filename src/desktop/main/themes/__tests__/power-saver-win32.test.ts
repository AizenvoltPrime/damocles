import { afterEach, describe, expect, it } from 'vitest';
import { batterySaverOn, resetBatterySaverBinding, type KoffiModule } from '../power-saver-win32';

// Windows battery saver through koffi's binding of kernel32's GetSystemPowerStatus: SystemStatusFlag, the struct's fourth byte,
// is 1 while it is on.

function fakeKoffi(answer: (status: Buffer) => number): { koffi: KoffiModule; bound: string[][]; calls: number } {
  const state = { bound: [] as string[][], calls: 0 };
  const koffi: KoffiModule = {
    load: (library) => ({
      func: (convention, name, result, parameters) => {
        state.bound.push([library, convention, name, result, ...parameters]);
        return (status: Buffer) => {
          state.calls++;
          return answer(status);
        };
      },
    }),
  };
  return { koffi, get bound() { return state.bound; }, get calls() { return state.calls; } };
}

const status = (flag: number) => (buffer: Buffer): number => {
  expect(buffer.length).toBe(12);
  buffer[0] = 0;
  buffer[3] = flag;
  return 1;
};

afterEach(() => resetBatterySaverBinding());

describe('batterySaverOn', () => {
  it('binds GetSystemPowerStatus once and reads SystemStatusFlag', () => {
    const fake = fakeKoffi(status(1));
    expect(batterySaverOn('win32', () => fake.koffi)).toBe(true);
    expect(batterySaverOn('win32', () => fake.koffi)).toBe(true);
    expect(fake.bound).toEqual([['kernel32.dll', '__stdcall', 'GetSystemPowerStatus', 'int', 'void *']]);
    expect(fake.calls).toBe(2);
  });

  it('reads battery saver off', () => {
    expect(batterySaverOn('win32', () => fakeKoffi(status(0)).koffi)).toBe(false);
  });

  it('answers undefined when the call fails or koffi cannot load, and off Windows without loading koffi', () => {
    expect(batterySaverOn('win32', () => fakeKoffi(() => 0).koffi)).toBeUndefined();
    resetBatterySaverBinding();
    expect(batterySaverOn('win32', () => {
      throw new Error('no koffi');
    })).toBeUndefined();
    let loaded = false;
    for (const platform of ['darwin', 'linux'] as const) {
      expect(batterySaverOn(platform, () => {
        loaded = true;
        return fakeKoffi(status(1)).koffi;
      })).toBeUndefined();
    }
    expect(loaded).toBe(false);
  });

  it('tries a binding that failed once per run, says so once, and binds again after a reset', () => {
    const lines: string[] = [];
    let loads = 0;
    const broken = (): KoffiModule => {
      loads++;
      throw new Error('no koffi');
    };
    expect(batterySaverOn('win32', broken, (line) => lines.push(line))).toBeUndefined();
    expect(batterySaverOn('win32', broken, (line) => lines.push(line))).toBeUndefined();
    expect(loads).toBe(1);
    expect(lines).toEqual(['[themes] Windows battery saver cannot be read, so it never pauses moving wallpapers in this run: no koffi']);
    resetBatterySaverBinding();
    expect(batterySaverOn('win32', () => fakeKoffi(status(1)).koffi)).toBe(true);
  });

  it('asks again after a call that failed: only a binding that cannot be made is given up', () => {
    let ok = false;
    const fake = fakeKoffi((buffer) => (ok ? status(1)(buffer) : 0));
    expect(batterySaverOn('win32', () => fake.koffi)).toBeUndefined();
    ok = true;
    expect(batterySaverOn('win32', () => fake.koffi)).toBe(true);
    expect(fake.bound).toHaveLength(1);
  });
});
