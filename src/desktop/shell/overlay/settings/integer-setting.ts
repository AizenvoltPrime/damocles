import type { InputParse } from '@/components/settings/controls/SettingInput.vue';
import { DESKTOP_CONFIGURATION } from '../../../main/desktop-configuration';

/**
 * A whole number within the key's declared range, as `isDesktopSettingValue` in main requires. Only decimal digits count:
 * Number() reads a blank field as 0 and accepts '0x10' and '1e1'.
 */
export function integerSetting(key: string, t: (key: string, values: Record<string, unknown>) => string): InputParse<number> {
  const property = DESKTOP_CONFIGURATION[key]!;
  const min = property.minimum ?? 0;
  const max = property.maximum ?? Number.MAX_SAFE_INTEGER;
  return (raw) => {
    const text = raw.trim();
    const value = Number(text);
    return /^\d+$/.test(text) && value >= min && value <= max
      ? { ok: true, value }
      : { ok: false, error: t('settingsHost.editor.integerRange', { min, max }) };
  };
}
