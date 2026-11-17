// Drive placement from QueryDosDeviceW; kept apart from network-fs.ts, which the workers and Playwright-loaded sources import.
import { queryDosDevice } from './dos-devices';
import { dosDeviceTargetPath } from './network-fs';

/**
 * Where Windows sends the paths of the drive whose root is `root` (`Z:\`, any case): `dosDeviceTargetPath` of what
 * QueryDosDeviceW answers now, or null for a local volume or a letter no drive has. Throws when Windows cannot be asked.
 */
export function mappedDrivePath(root: string): string | null {
  const target = queryDosDevice(root.slice(0, 2).toUpperCase());
  return target === undefined ? null : dosDeviceTargetPath(target);
}
