import { describe, expect, it } from 'vitest';
import { createDesktopLocalizationService } from '../../local-services/localization-service';
import { transportOutputDocument } from '../host-output';
import type { HostRecord } from '../remote/host-store';

const SSH = { id: 'h1', kind: 'ssh', destination: { kind: 'alias', alias: 'box' }, name: 'box', recentFolders: [], settings: {} } as unknown as HostRecord;
const WSL = { id: 'h2', kind: 'wsl', distro: 'Ubuntu-24.04', name: 'ubuntu', recentFolders: [], settings: {} } as unknown as HostRecord;
const CONTAINER = { id: 'h3', kind: 'container', key: 'k', engine: 'podman', origin: 'attach', name: 'api', recentFolders: [], settings: {} } as unknown as HostRecord;

describe('Show log\'s transport output', () => {
  const en = createDesktopLocalizationService(process.cwd(), 'en', () => undefined);
  const el = createDesktopLocalizationService(process.cwd(), 'el', () => undefined);

  it('titles the output by the program that wrote it, never ssh for a host ssh never reached', () => {
    expect(transportOutputDocument(SSH, 'box', '', en.t)).toEqual({ title: 'box: ssh output', text: 'ssh wrote nothing.', fileName: 'ssh-output.log' });
    expect(transportOutputDocument(WSL, 'ubuntu', '', en.t)).toEqual({ title: 'ubuntu: wsl.exe output', text: 'wsl.exe wrote nothing.', fileName: 'wsl-output.log' });
    expect(transportOutputDocument(CONTAINER, 'api', '', en.t)).toEqual({ title: 'api: podman exec output', text: 'podman exec wrote nothing.', fileName: 'container-output.log' });
    expect(transportOutputDocument(WSL, 'ubuntu', 'Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\n', en.t).text).toBe('Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\n');
  });

  it('says it in Greek too', () => {
    expect(transportOutputDocument(WSL, 'ubuntu', '', el.t)).toMatchObject({ title: 'ubuntu: Έξοδος wsl.exe', text: 'Το wsl.exe δεν έγραψε τίποτα.' });
    expect(transportOutputDocument(CONTAINER, 'api', '', el.t)).toMatchObject({ title: 'api: Έξοδος podman exec', text: 'Το podman exec δεν έγραψε τίποτα.' });
  });
});
