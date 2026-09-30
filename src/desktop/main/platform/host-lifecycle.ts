import type { HostLifecycle } from '../../../platform/host-lifecycle';

// reload disposes the core services and builds them again, which is what a window reload does for the extension.
export function createDesktopHostLifecycle(reload: () => Promise<void>): HostLifecycle {
  return { reload };
}
