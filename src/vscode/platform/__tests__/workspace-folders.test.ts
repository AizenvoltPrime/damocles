import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __trustEmitter } from 'vscode';
import { createVsCodeWorkspaceFolders } from '../workspace-folders';
import { createVsCodeTrustService } from '../trust-service';
import { homeDirectory } from '../../../core/workspace-folders/folder-registry';

type MockFolder = { uri: { fsPath: string; scheme: string }; name: string };

function setWorkspaceFolders(folders: readonly MockFolder[] | undefined): void {
  (vscode.workspace as unknown as { workspaceFolders: readonly MockFolder[] | undefined }).workspaceFolders = folders;
}

const folder = (fsPath: string, name: string, scheme = 'file'): MockFolder => ({ uri: { fsPath, scheme }, name });

afterEach(() => {
  setWorkspaceFolders([]);
  __trustEmitter.clear();
});

describe('createVsCodeWorkspaceFolders', () => {
  it('returns only file-scheme folders, in workspace order', () => {
    setWorkspaceFolders([
      folder('/b', 'b'),
      folder('/remote', 'remote', 'vscode-remote'),
      folder('/a', 'a'),
      folder('/virtual', 'virtual', 'vscode-vfs'),
    ]);

    expect(createVsCodeWorkspaceFolders().folders()).toEqual([
      { fsPath: '/b', name: 'b' },
      { fsPath: '/a', name: 'a' },
    ]);
  });

  it('returns an empty list when no folder is open', () => {
    setWorkspaceFolders(undefined);

    expect(createVsCodeWorkspaceFolders().folders()).toEqual([]);
  });
});

describe('createVsCodeTrustService', () => {
  it('fires onDidGrantTrust with every open file-scheme folder path', () => {
    setWorkspaceFolders([folder('/a', 'a'), folder('/remote', 'remote', 'vscode-remote'), folder('/b', 'b')]);
    const cb = vi.fn();
    const subscription = createVsCodeTrustService().onDidGrantTrust(cb);

    __trustEmitter.fire();

    expect(cb).toHaveBeenCalledExactlyOnceWith(['/a', '/b']);
    subscription.dispose();
  });

  it('fires onDidGrantTrust with the home target when no file-scheme folder is open', () => {
    setWorkspaceFolders([folder('/remote', 'remote', 'vscode-remote')]);
    const cb = vi.fn();
    const subscription = createVsCodeTrustService().onDidGrantTrust(cb);

    __trustEmitter.fire();

    expect(cb).toHaveBeenCalledExactlyOnceWith([homeDirectory()]);
    subscription.dispose();
  });

  it('reports window trust whatever folder it is asked about', () => {
    const trust = createVsCodeTrustService();
    vscode.__setTrusted(false);
    expect(trust.isTrusted('/a')).toBe(false);
    vscode.__setTrusted(true);
    expect(trust.isTrusted('/elsewhere')).toBe(true);
  });
});
