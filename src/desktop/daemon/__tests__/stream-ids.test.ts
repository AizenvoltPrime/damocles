import { describe, expect, it } from 'vitest';
import { FIRST_DYNAMIC } from '../../../remote/mux';
import { INVALID, type Parser } from '../../core-protocol/schema';
import { CLIENT_TO_WORKSPACE } from '../../workspace/messages';
import { CLIENT_TO_CONTROL } from '../control-messages';
import { CLIENT_TO_PORTS } from '../ports/ports-messages';

// every request that names a client-opened stream, with its other params valid
const naming: ReadonlyArray<readonly [string, Parser<unknown>, Record<string, unknown>]> = [
  ['ports.connect', CLIENT_TO_PORTS.requests.connect.params, { host: 'localhost', port: 80 }],
  ['agent.connect', CLIENT_TO_CONTROL.requests['agent.connect'].params, { request: 1 }],
  ['containers.exec', CLIENT_TO_CONTROL.requests['containers.exec'].params, { engine: 'docker', containerId: 'a'.repeat(64), user: 'root' }],
  ['containers.up', CLIENT_TO_CONTROL.requests['containers.up'].params, { engine: 'docker', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer/devcontainer.json', dataKey: 'a'.repeat(32), removeExisting: false }],
  ['containers.readConfiguration', CLIENT_TO_CONTROL.requests['containers.readConfiguration'].params, { engine: 'docker', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer/devcontainer.json', trustReadId: 'b'.repeat(32) }],
  ['files.readFile', CLIENT_TO_WORKSPACE.requests['files.readFile'].params, { project: { key: '/srv/app', fsPath: '/srv/app', name: 'app' }, relativePath: 'a.txt' }],
  ['files.receiveFile', CLIENT_TO_WORKSPACE.requests['files.receiveFile'].params, { project: { key: '/srv/app', fsPath: '/srv/app', name: 'app' }, relativeDir: '', name: 'a.txt', mode: 0o644, mtimeMs: 0, replace: false, size: 3 }],
];

describe('a stream a request names', () => {
  it.each(naming)('%s takes exactly the ids the mux opens', (_name, parse, rest) => {
    for (const stream of [0, 1, FIRST_DYNAMIC - 1, FIRST_DYNAMIC + 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(parse({ ...rest, stream }), String(stream)).toBe(INVALID);
    for (const stream of [FIRST_DYNAMIC, FIRST_DYNAMIC + 1, 2 ** 31 + 1, Number.MAX_SAFE_INTEGER]) expect(parse({ ...rest, stream }), String(stream)).not.toBe(INVALID);
  });
});
