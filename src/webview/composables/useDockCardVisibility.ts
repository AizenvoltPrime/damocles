import type { MaybeRefOrGetter } from 'vue';
import { useConnectionStore } from '@/stores/useConnectionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useTrustedVisibility, type TrustedVisibility } from './useTrustedVisibility';

/**
 * The gate of a card in the chat page's prompts: checked where the host paints theme CSS, and quiet while the host is
 * away, when the dimmed prompts are held and the page says so above them.
 */
export function useDockCardVisibility(target: MaybeRefOrGetter<HTMLElement | null | undefined>): TrustedVisibility {
  const settings = useSettingsStore();
  const connection = useConnectionStore();
  return useTrustedVisibility(target, () => settings.hostCapabilities.damoclesTheme, { quiet: () => connection.awayShown });
}
