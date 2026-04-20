import { ref, watch } from 'vue';
import { useVSCode } from './useVSCode';

const MIN_VH = 20;
const MAX_VH = 80;
const DEFAULT_VH = 40;
const STATE_KEY = 'userMessageMaxHeightVh';

function clamp(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VH;
  return Math.max(MIN_VH, Math.min(MAX_VH, value));
}

const maxHeightVh = ref<number>(DEFAULT_VH);
let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;

  const { getState, setState } = useVSCode();
  const stored = (getState<Record<string, unknown>>() ?? {})[STATE_KEY];
  if (typeof stored === 'number') maxHeightVh.value = clamp(stored);

  watch(maxHeightVh, (next) => {
    const current = getState<Record<string, unknown>>() ?? {};
    setState({ ...current, [STATE_KEY]: next });
  });
}

export function useUserMessageMaxHeight() {
  ensureInitialized();
  return { maxHeightVh, MIN_VH, MAX_VH, DEFAULT_VH, clamp };
}
