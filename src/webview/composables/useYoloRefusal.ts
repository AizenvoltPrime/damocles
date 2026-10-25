import { readonly, ref, type Ref } from 'vue';

// How long the composer's calm notice stays after a refused YOLO.
const YOLO_REFUSAL_MS = 6000;

const shown = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

/** The chat's host refused YOLO (core's permissionModeRefused, or a click the host capabilities already refuse). */
export function showYoloRefusal(): void {
  shown.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    shown.value = false;
  }, YOLO_REFUSAL_MS);
}

export function useYoloRefusal(): Readonly<Ref<boolean>> {
  return readonly(shown);
}
