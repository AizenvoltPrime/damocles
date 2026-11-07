import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
  WebContentsView: vi.fn(),
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  protocol: {},
}));

import { parseDesignMarkupSend, parseDesignTweakApply, parseDesignTweakKeep } from '../shell';

describe('the shell\'s markup send (PD-12)', () => {
  const json = { file: 'screens/S1.html', marks: [] };

  it('takes a tab, a PNG data URL and an object, which core parses as the markup', () => {
    expect(parseDesignMarkupSend({ tabId: 'design-1', png: 'data:image/png;base64,iVBORw0KGgo=', json })).toEqual({ tabId: 'design-1', png: 'data:image/png;base64,iVBORw0KGgo=', json });
  });

  it('refuses another image type, a URL, an oversized capture, a missing tab and markup that is no object', () => {
    for (const request of [
      { tabId: 'design-1', png: 'data:image/svg+xml;base64,PHN2Zz4=', json },
      { tabId: 'design-1', png: 'https://example.com/a.png', json },
      // past what a 1950 px capture can be, about 20 MiB of base64
      { tabId: 'design-1', png: `data:image/png;base64,${'A'.repeat(24 * 1024 * 1024)}`, json },
      { tabId: '', png: 'data:image/png;base64,iVBORw0KGgo=', json },
      { tabId: 'design-1', png: 'data:image/png;base64,iVBORw0KGgo=', json: 'marks' },
      null,
    ]) {
      expect(parseDesignMarkupSend(request)).toBeUndefined();
    }
  });
});

describe('the shell\'s tweaks (PD-13)', () => {
  it('takes a tab and two token names to apply, and a tab, a tweak id and a token to keep', () => {
    expect(parseDesignTweakApply({ tabId: 'design-1', property: '--radius', token: '--radius-lg' })).toEqual({ tabId: 'design-1', property: '--radius', token: '--radius-lg' });
    expect(parseDesignTweakKeep({ tabId: 'design-1', tweakId: 'radius', value: '--radius-lg' })).toEqual({ tabId: 'design-1', tweakId: 'radius', value: '--radius-lg' });
  });

  it('refuses any name that is not a token before it reaches main\'s CSS', () => {
    for (const request of [
      { tabId: 'design-1', property: '--radius', token: '--x);}body{display:none' },
      { tabId: 'design-1', property: 'border-radius', token: '--radius-lg' },
      { tabId: 'design-1', property: '--radius', token: 'var(--radius-lg)' },
      { tabId: '', property: '--radius', token: '--radius-lg' },
      null,
    ]) {
      expect(parseDesignTweakApply(request)).toBeUndefined();
    }
    for (const request of [
      { tabId: 'design-1', tweakId: 'radius"', value: '--radius-lg' },
      { tabId: 'design-1', tweakId: 'radius', value: '12px' },
      { tabId: 'design-1', tweakId: 'radius' },
    ]) {
      expect(parseDesignTweakKeep(request)).toBeUndefined();
    }
  });
});
