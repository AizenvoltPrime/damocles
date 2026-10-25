import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstMachineIdFile, machineRunKey, parseMachineGuid, parsePlatformUuid, runKeyOf } from '../machine-id';

describe('the machine key of the run folder', () => {
  it('reads MachineGuid from reg.exe and IOPlatformUUID from ioreg', () => {
    const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    3F2504E0-4F89-11D3-9A0C-0305E82C3301\r\n\r\n';
    expect(parseMachineGuid(reg)).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    expect(parseMachineGuid('ERROR: The system was unable to find the specified registry key or value.')).toBeUndefined();
    const ioreg = '+-o IOPlatformExpertDevice  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformSerialNumber" = "C02XXXXX"\n      "IOPlatformUUID" = "564D1C1D-1B2A-4C3D-8E9F-0A1B2C3D4E5F"\n    }\n';
    expect(parsePlatformUuid(ioreg)).toBe('564d1c1d-1b2a-4c3d-8e9f-0a1b2c3d4e5f');
    expect(parsePlatformUuid('')).toBeUndefined();
  });

  it('takes the first machine-id file that holds an id, skipping an empty or uninitialized one, as containers have', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-machine-id-'));
    const [empty, uninitialized, dbus, missing] = ['etc', 'first-boot', 'dbus', 'none'].map((name) => path.join(dir, name)) as [string, string, string, string];
    fs.writeFileSync(empty, '');
    fs.writeFileSync(uninitialized, 'uninitialized\n');
    fs.writeFileSync(dbus, '0123456789abcdef0123456789abcdef\n');
    expect(await firstMachineIdFile([missing, empty, uninitialized, dbus])).toBe('0123456789abcdef0123456789abcdef');
    expect(await firstMachineIdFile([missing, empty])).toBeUndefined();
  });

  it('names the folder by 16 hex digits of an HMAC keyed by the id, never the id itself', () => {
    const id = '0123456789abcdef0123456789abcdef';
    expect(runKeyOf(id)).toMatch(/^[0-9a-f]{16}$/);
    expect(runKeyOf(id)).toBe(runKeyOf(id));
    expect(runKeyOf(id)).not.toBe(runKeyOf('fedcba9876543210fedcba9876543210'));
    expect(id.includes(runKeyOf(id))).toBe(false);
  });

  it('keys this machine by its id rather than its hostname, read once per process', async () => {
    const key = machineRunKey();
    expect(machineRunKey()).toBe(key);
    expect(await key).toMatch(/^[0-9a-f]{16}$/);
    // CI runners and this machine all have a machine id; only some containers fall back to the hostname
    expect(await key).not.toBe(runKeyOf(`hostname:${os.hostname()}`));
  });
});
