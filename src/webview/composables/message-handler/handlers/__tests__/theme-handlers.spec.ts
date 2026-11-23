import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { createThemeHandlers } from '../theme-handlers';
import type { HandlerContext } from '../../types';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { installThumbs } from '@/utils/install-thumbs';
import { installPreview } from '@/components/theme/__tests__/install-preview';

function deliver(message: ExtensionToWebviewMessage): void {
  const handlers = createThemeHandlers() as Record<string, (msg: ExtensionToWebviewMessage, ctx: HandlerContext) => void>;
  handlers[message.type]!(message, {} as HandlerContext);
}

const CHANGE = {
  type: 'requestThemeChange', promptId: 'tc-1', toolUseId: 'call_1', action: 'schedule', looks: [], isNew: false, changes: [{ kind: 'schedule', enabled: true, rules: 2 }],
  contrast: [], state: 'waiting', planMode: false, canShowInWindow: false, showInWindow: false, owner: { kind: 'main' },
} as const satisfies ExtensionToWebviewMessage;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  useThemePromptStore().$reset();
});

describe('the theme card messages', () => {
  it('raise a change card, change it, post it again as core\'s answer, and close it', () => {
    const store = useThemePromptStore();
    deliver(CHANGE);
    expect(store.changePrompts).toEqual([expect.objectContaining({ promptId: 'tc-1', state: 'waiting' })]);
    expect(store.changePrompts[0]).not.toHaveProperty('type');

    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'applying' });
    expect(store.changePrompts[0]!.state).toBe('applying');
    deliver({ ...CHANGE, state: 'outdated' });
    expect(store.changePrompts.map((held) => held.state)).toEqual(['outdated']);

    deliver({ type: 'themeChangeClosed', promptId: 'tc-1' });
    expect(store.changePrompts).toEqual([]);
  });

  it('raise and close a screenshot card', () => {
    const store = useThemePromptStore();
    deliver({ type: 'requestThemeScreenshot', promptId: 'ts-1', toolUseId: 'call_2', url: `app://damocles/theme-shot/${'3f'.repeat(16)}`, width: 1280, height: 800, owner: { kind: 'main' } });
    expect(store.screenshotPrompts.map((held) => held.promptId)).toEqual(['ts-1']);
    deliver({ type: 'themeScreenshotClosed', promptId: 'ts-1' });
    expect(store.screenshotPrompts).toEqual([]);
  });

  it('raise an install card whose thumbnails go to the page\'s image cache, follow its updates and progress, and close it', () => {
    const store = useThemePromptStore();
    const preview = installPreview();
    const sha = preview.wallpapers[1]!.sha256;
    deliver({ type: 'requestThemeInstall', promptId: 'ti-1', toolUseId: 'call_3', preview, owner: { kind: 'main' } });
    deliver({ type: 'themeInstallProgress', promptId: 'ti-1', sha256: sha, fraction: 0.5 });
    expect(store.installPrompts[0]!.progress).toEqual({ [sha]: 0.5 });
    expect(installThumbs('ti-1')).toEqual({});

    deliver({ type: 'themeInstallUpdated', promptId: 'ti-1', preview: { ...preview, wallpapers: [preview.wallpapers[0]!, { ...preview.wallpapers[1]!, flash: 'flagged', thumb: 'data:image/webp;base64,UklGRg==' }] } });
    expect(store.installPrompts[0]!.preview.wallpapers[1]).toMatchObject({ flash: 'flagged' });
    expect(installThumbs('ti-1')[sha]).toMatch(/^blob:/);
    expect(JSON.stringify(getActivePinia()!.state.value)).not.toContain('data:image');

    deliver({ type: 'themeInstallClosed', promptId: 'ti-1' });
    expect(store.installPrompts).toEqual([]);
    expect(installThumbs('ti-1')).toEqual({});
  });
});
