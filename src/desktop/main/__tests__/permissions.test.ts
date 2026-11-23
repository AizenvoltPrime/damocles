import { describe, expect, it, vi } from 'vitest';
import type { Session, WebContents } from 'electron';

vi.mock('electron', () => ({ protocol: {} }));

import { isPermissionAllowed, registerLocalFontsContents, registerPanelContents, restrictPermissions } from '../security';

const panel = { id: 1 } as unknown as WebContents;
const other = { id: 2 } as unknown as WebContents;
const dock = { id: 3 } as unknown as WebContents;
const overlay = { id: 4 } as unknown as WebContents;
registerPanelContents(panel);
registerLocalFontsContents(dock);
registerLocalFontsContents(overlay);
const page = 'app://damocles/panel/abc/index.html';
const dockPage = 'app://damocles/theme-editor/index.html';
const overlayPage = 'app://damocles/overlay/index.html';

describe('permission handlers', () => {
  it('allow clipboard-sanitized-write for a panel view main frame on the app origin', () => {
    expect(isPermissionAllowed({ contents: panel, permission: 'clipboard-sanitized-write', requester: page, isMainFrame: true })).toBe(true);
    expect(isPermissionAllowed({ contents: panel, permission: 'clipboard-sanitized-write', requester: 'app://damocles', isMainFrame: true })).toBe(true);
  });

  it.each([
    ['a different origin', { contents: panel, permission: 'clipboard-sanitized-write', requester: 'https://example.com/', isMainFrame: true }],
    ['a look-alike origin', { contents: panel, permission: 'clipboard-sanitized-write', requester: 'app://damocles.evil/x', isMainFrame: true }],
    ['a non-panel webContents', { contents: other, permission: 'clipboard-sanitized-write', requester: page, isMainFrame: true }],
    ['no webContents', { contents: null, permission: 'clipboard-sanitized-write', requester: page, isMainFrame: true }],
    ['a subframe', { contents: panel, permission: 'clipboard-sanitized-write', requester: page, isMainFrame: false }],
    ['clipboard-read', { contents: panel, permission: 'clipboard-read', requester: page, isMainFrame: true }],
    ['media', { contents: panel, permission: 'media', requester: page, isMainFrame: true }],
    ['notifications', { contents: panel, permission: 'notifications', requester: page, isMainFrame: true }],
  ])('deny %s', (_name, query) => {
    expect(isPermissionAllowed(query)).toBe(false);
  });

  it('allow local-fonts only for the theme editor dock\'s and the overlay\'s main frames on the app origin', () => {
    expect(isPermissionAllowed({ contents: dock, permission: 'local-fonts', requester: dockPage, isMainFrame: true })).toBe(true);
    expect(isPermissionAllowed({ contents: dock, permission: 'local-fonts', requester: 'app://damocles', isMainFrame: true })).toBe(true);
    expect(isPermissionAllowed({ contents: overlay, permission: 'local-fonts', requester: overlayPage, isMainFrame: true })).toBe(true);
  });

  it.each([
    ['a chat page', { contents: panel, permission: 'local-fonts', requester: page, isMainFrame: true }],
    ['another webContents, the shell and the popup window page among them', { contents: other, permission: 'local-fonts', requester: 'app://damocles', isMainFrame: true }],
    ['a subframe of the overlay', { contents: overlay, permission: 'local-fonts', requester: overlayPage, isMainFrame: false }],
    ['another origin in the overlay', { contents: overlay, permission: 'local-fonts', requester: 'https://example.com/', isMainFrame: true }],
    ['the clipboard in the overlay', { contents: overlay, permission: 'clipboard-sanitized-write', requester: overlayPage, isMainFrame: true }],
    ['a subframe of the dock', { contents: dock, permission: 'local-fonts', requester: dockPage, isMainFrame: false }],
    ['another origin in the dock', { contents: dock, permission: 'local-fonts', requester: 'https://example.com/', isMainFrame: true }],
    ['a look-alike origin in the dock', { contents: dock, permission: 'local-fonts', requester: 'app://damocles.evil', isMainFrame: true }],
    ['no webContents', { contents: null, permission: 'local-fonts', requester: dockPage, isMainFrame: true }],
    ['the clipboard in the dock', { contents: dock, permission: 'clipboard-sanitized-write', requester: dockPage, isMainFrame: true }],
  ])('deny local-fonts or the clipboard to %s', (_name, query) => {
    expect(isPermissionAllowed(query)).toBe(false);
  });

  it('install the same rule in the request and check handlers and deny every device', () => {
    const session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
    };
    restrictPermissions(session as unknown as Session);
    const request = session.setPermissionRequestHandler.mock.calls[0]?.[0];
    const check = session.setPermissionCheckHandler.mock.calls[0]?.[0];
    const device = session.setDevicePermissionHandler.mock.calls[0]?.[0];

    const granted = vi.fn();
    request(panel, 'clipboard-sanitized-write', granted, { requestingUrl: page, isMainFrame: true });
    request(panel, 'media', granted, { requestingUrl: page, isMainFrame: true });
    request(other, 'clipboard-sanitized-write', granted, { requestingUrl: page, isMainFrame: true });
    expect(granted.mock.calls).toEqual([[true], [false], [false]]);

    expect(check(panel, 'clipboard-sanitized-write', 'app://damocles', { isMainFrame: true })).toBe(true);
    expect(check(panel, 'clipboard-read', 'app://damocles', { isMainFrame: true })).toBe(false);
    expect(check(panel, 'clipboard-sanitized-write', 'app://damocles', { isMainFrame: false })).toBe(false);
    expect(check(dock, 'local-fonts', 'app://damocles', { isMainFrame: true })).toBe(true);
    expect(check(panel, 'local-fonts', 'app://damocles', { isMainFrame: true })).toBe(false);
    const fonts = vi.fn();
    request(dock, 'local-fonts', fonts, { requestingUrl: dockPage, isMainFrame: true });
    request(other, 'local-fonts', fonts, { requestingUrl: 'app://damocles/shell/index.html', isMainFrame: true });
    expect(fonts.mock.calls).toEqual([[true], [false]]);
    expect(device()).toBe(false);
  });
});
