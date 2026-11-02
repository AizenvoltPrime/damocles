import { describe, expect, it } from 'vitest';
import { inspectArgs } from '../../../../daemon/container-commands';
import { MAX_LISTED_CONTAINERS, parseInspect, parsePs } from '../docker-ps';

const ID = '28f4e6f33d7eb0c2fa0a1a525fdb39d5ef72c206dbca3f397ed48e8b10aa3a24';
const ID2 = 'aa00bb11cc22dd33ee44ff5566778899aa00bb11cc22dd33ee44ff5566778899';
const row = (fields: Record<string, unknown>): string => JSON.stringify({ ID, Names: 'charming_swirles', Image: 'node:24-alpine', Status: 'Up 9 seconds', State: 'running', Labels: 'a=b', ...fields });

describe('docker ps', () => {
  it("reads docker's rows and podman's (Id, a Names list)", () => {
    const stdout = `${row({})}\n${JSON.stringify({ Id: ID2, Names: ['web', 'alias'], Image: 'docker.io/library/nginx:1', Status: 'Up 2 hours', State: 'paused' })}\n`;
    expect(parsePs(stdout)).toEqual([
      { id: ID, name: 'charming_swirles', image: 'node:24-alpine', status: 'Up 9 seconds', state: 'running' },
      { id: ID2, name: 'web', image: 'docker.io/library/nginx:1', status: 'Up 2 hours', state: 'paused' },
    ]);
    expect(parsePs(row({ Names: 'first,second', State: 'exited' }))).toEqual([{ id: ID, name: 'first', image: 'node:24-alpine', status: 'Up 9 seconds', state: 'other' }]);
    // a legacy link alias may come first; the container's own name has no slash
    expect(parsePs(row({ Names: 'web/db,db' }))).toMatchObject([{ name: 'db' }]);
    expect(parsePs(JSON.stringify({ Id: ID2, Names: ['web/db', 'db'], Image: 'x', Status: 'Up', State: 'running' }))).toMatchObject([{ name: 'db' }]);
  });

  it('leaves out a row whose id, name, image or status is not one Damocles takes, and lines that are no JSON object', () => {
    const bad = [
      row({ ID: '--privileged' }),
      row({ ID: 'XYZ' }),
      row({ Names: '-name' }),
      row({ Names: 'a b' }),
      row({ Image: '' }),
      row({ Image: 'evil\u202Eimage' }),
      row({ Status: 'Up\nrooted' }),
      row({ Status: 'x'.repeat(600) }),
      '[1,2]',
      'not json',
    ];
    expect(parsePs(bad.join('\n'))).toEqual([]);
  });

  it('lists at most MAX_LISTED_CONTAINERS rows', () => {
    const lines = Array.from({ length: MAX_LISTED_CONTAINERS + 3 }, () => row({}));
    expect(parsePs(lines.join('\n'))).toHaveLength(MAX_LISTED_CONTAINERS);
  });
});

describe('inspect', () => {
  const container = (fields: Record<string, unknown>, config: Record<string, unknown> = {}): Record<string, unknown> => ({ Id: ID, Name: '/web', State: { Running: true }, Config: { Image: 'node:24', User: '', Labels: {}, ...config }, ...fields });

  it("takes the devcontainer metadata's last remoteUser over the image's user, and no user as root", () => {
    const metadata = JSON.stringify([{ remoteUser: 'vscode' }, { id: 'feature' }, { remoteUser: 'node' }]);
    const stdout = JSON.stringify([container({}, { User: 'app', Labels: { 'devcontainer.metadata': metadata } }), container({ Id: ID2, Name: '/plain', State: { Running: false } }, { User: '1000:1000' }), container({ Name: '/root' })]);
    expect(parseInspect(stdout)).toEqual([
      { id: ID, name: 'web', image: 'node:24', running: true, paused: false, volumes: [], user: 'node' },
      { id: ID2, name: 'plain', image: 'node:24', running: false, paused: false, volumes: [], user: '1000:1000' },
      { id: ID, name: 'root', image: 'node:24', running: true, paused: false, volumes: [] },
    ]);
  });

  it('never replaces a configured user no exec takes with root', () => {
    expect(parseInspect(JSON.stringify([container({}, { User: '-u root' })]))).toEqual([{ id: ID, name: 'web', image: 'node:24', running: true, paused: false, volumes: [], userRefused: true }]);
    expect(parseInspect(JSON.stringify([container({}, { Labels: { 'devcontainer.metadata': JSON.stringify({ remoteUser: 'a b' }) } })]))).toEqual([{ id: ID, name: 'web', image: 'node:24', running: true, paused: false, volumes: [], userRefused: true }]);
  });

  it('reads a paused container as not running, though docker reports it Running', () => {
    expect(parseInspect(JSON.stringify([container({ State: { Running: true, Paused: true, Status: 'paused' } })]))).toMatchObject([{ running: false, paused: true }]);
  });

  it('ignores an empty remoteUser in the metadata, as the CLI reads it unset', () => {
    const metadata = JSON.stringify([{ remoteUser: 'node' }, { remoteUser: '' }]);
    expect(parseInspect(JSON.stringify([container({}, { Labels: { 'devcontainer.metadata': metadata } })]))).toMatchObject([{ user: 'node' }]);
  });

  it('lists the named volumes mounted and leaves out binds and entries that fail a check', () => {
    const mounts = [
      { Type: 'volume', Name: 'damocles-data-x', Source: '/var/lib/docker/volumes/damocles-data-x/_data', Destination: '/var/lib/damocles-data', RW: true },
      { Type: 'bind', Source: '/srv/app', Destination: '/workspaces/app' },
      { Type: 'volume', Name: 'evil\u202Ename', Destination: '/v' },
      { Type: 'volume', Name: 'rel', Destination: 'relative' },
      'text',
    ];
    expect(parseInspect(JSON.stringify([container({ Mounts: mounts })]))).toMatchObject([{ volumes: [{ name: 'damocles-data-x', destination: '/var/lib/damocles-data' }] }]);
    expect(parseInspect(JSON.stringify([container({ Mounts: 'none' })]))).toMatchObject([{ volumes: [] }]);
  });

  it('leaves out a container whose id or name is not one Damocles takes', () => {
    expect(parseInspect(JSON.stringify([container({ Id: 'x' }), container({ Name: '/-bad' }), 'text']))).toEqual([]);
    expect(parseInspect('not json')).toEqual([]);
  });

  it('builds its argv from container ids only', () => {
    expect(inspectArgs([ID, ID2])).toEqual(['inspect', '--type', 'container', ID, ID2]);
    expect(() => inspectArgs(['--format=x'])).toThrow(RangeError);
    expect(() => inspectArgs([])).toThrow(RangeError);
  });
});
