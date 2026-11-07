import { shallowRef } from 'vue';
import type { UserImageOrigin } from '@shared/types/content';
import type { DesignPreviewImage } from '@shared/types/design';

export interface CapturedImage {
  readonly image: DesignPreviewImage;
  readonly origin: UserImageOrigin;
}

// Images main captured for a composer that has not mounted yet. Module state, never a Pinia store, so no store holds image data.
const queued = shallowRef<readonly CapturedImage[]>([]);

export function queueCapturedImage(captured: CapturedImage): void {
  queued.value = [...queued.value, captured];
}

/** The queued images, in arrival order, leaving none queued. */
export function takeCapturedImages(): readonly CapturedImage[] {
  const taken = queued.value;
  queued.value = [];
  return taken;
}
