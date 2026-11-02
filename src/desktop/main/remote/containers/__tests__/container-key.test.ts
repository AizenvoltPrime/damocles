import { describe, expect, it } from 'vitest';
import { authorityKeyOfProject, projectKeyOf } from '../../../../../shared/project-location';
import { attachKey, CONTAINER_KEY, containerAuthorityKey, devcontainerKey } from '../container-key';

describe('the container key', () => {
  it('derives from where the CLI runs, the folder and the configuration, so the same project keeps its key across a rebuild', () => {
    const before = devcontainerKey(undefined, 'C:\\work\\app', 'C:\\work\\app\\.devcontainer\\devcontainer.json');
    // a rebuild changes the container id and image, neither of which is an input
    const after = devcontainerKey(undefined, 'C:\\work\\app', 'C:\\work\\app\\.devcontainer\\devcontainer.json');
    expect(after).toBe(before);
    expect(before).toMatch(CONTAINER_KEY);
    const projectKey = projectKeyOf({ kind: 'container', key: before }, '/workspaces/app');
    expect(projectKeyOf({ kind: 'container', key: after }, '/workspaces/app')).toBe(projectKey);
    expect(authorityKeyOfProject(projectKey)).toBe(containerAuthorityKey(before));
  });

  it('differs for another SSH host, folder or configuration file', () => {
    const base = devcontainerKey(undefined, '/srv/app', '/srv/app/.devcontainer/devcontainer.json');
    expect(devcontainerKey('h1', '/srv/app', '/srv/app/.devcontainer/devcontainer.json')).not.toBe(base);
    expect(devcontainerKey(undefined, '/srv/app2', '/srv/app/.devcontainer/devcontainer.json')).not.toBe(base);
    expect(devcontainerKey(undefined, '/srv/app', '/srv/app/.devcontainer.json')).not.toBe(base);
    // the parts are encoded apart, so moving text between them gives another key
    expect(devcontainerKey(undefined, '/srv/a', 'pp/c')).not.toBe(devcontainerKey(undefined, '/srv/ap', 'p/c'));
  });

  it("keys an attached container by its name, which a re-created container keeps, apart from any devcontainer's key", () => {
    expect(attachKey(undefined, 'web')).toBe(attachKey(undefined, 'web'));
    expect(attachKey('h1', 'web')).not.toBe(attachKey(undefined, 'web'));
    expect(attachKey(undefined, 'web')).not.toBe(devcontainerKey(undefined, 'web', ''));
    expect(attachKey(undefined, 'web')).toMatch(CONTAINER_KEY);
  });
});
