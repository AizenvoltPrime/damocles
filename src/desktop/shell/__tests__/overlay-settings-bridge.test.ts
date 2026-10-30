import { describe, expect, it, vi } from 'vitest';
import type { DamoclesOverlayApi } from '../../preload/overlay-channels';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';

describe('the overlay\'s settings bridge', () => {
  it('hands the settings view a chat\'s message only once its LocalizedText parses', () => {
    let listener: ((message: unknown) => void) | undefined;
    const api = { onSettingsMessage: (next: (message: unknown) => void) => { listener = next; return () => undefined; } } as unknown as DamoclesOverlayApi;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const received: unknown[] = [];
    createOverlaySettingsBridge(api).onMessage((message) => received.push(message));
    const good = { type: 'settingWriteResult', key: 'damocles.x', ok: false, error: { message: 'The file is read-only.' } };
    listener?.({ ...good, error: 'The file is read-only.' });
    listener?.(good);
    expect(received).toEqual([good]);
    expect(errors).toHaveBeenCalledWith('[bridge] dropped a settingWriteResult message: its .error is not LocalizedText');
    errors.mockRestore();
  });
});
