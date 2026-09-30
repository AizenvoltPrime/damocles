import type { Platform } from '../platform/platform';

// Installed by the host as the first statement of activate; workers never call platform().
let installed: Platform | undefined;

export function installPlatform(p: Platform): void {
  installed = p;
}

export function platform(): Platform {
  if (!installed) {
    throw new Error('Platform not installed: the host must call installPlatform() before core code runs');
  }
  return installed;
}
