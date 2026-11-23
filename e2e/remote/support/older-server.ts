import * as fs from 'node:fs';
import { readTarGz } from '../../../scripts/server-archive.ts';
import { LINUX_TARGET } from './release-mirror';
import { runProgram, TARGET_HOME, type SshdFixture } from './sshd';

// Another build's server on the target: unpacked where stage 1 would have installed it, so a launch running as that build
// finds it and starts its daemon, and the updated app meets that daemon running.

const DAEMON_SERVE = /\/\.damocles\/server\/([^/]+)-[a-z]+-(?:x64|arm64)\/node\/node .*\/dist\/daemon\.js serve\b/;

/** The install folder of server version `version` in the target account's default install. */
export const versionFolder = (version: string): string => `${TARGET_HOME}/.damocles/server/${version}-${LINUX_TARGET}`;

/** The server version of every running daemon of the account, from its program's install folder. */
export async function daemonVersions(fixture: Pick<SshdFixture, 'userProcesses'>): Promise<string[]> {
  return (await fixture.userProcesses()).flatMap((line) => DAEMON_SERVE.exec(line)?.[1] ?? []);
}

/** The server version `archive` installs as: its server-package.json's serverVersion, or the version of a package built before it had one. */
export function packageVersion(archive: string): string {
  const info = (readTarGz(fs.readFileSync(archive)) as Array<{ path: string; data: Buffer }>).find((entry) => entry.path === 'server-package.json');
  if (info === undefined) throw new Error(`${archive} is no server package`);
  const { serverVersion, version } = JSON.parse(info.data.toString('utf8')) as { serverVersion?: string; version?: string };
  const found = serverVersion ?? version;
  if (found === undefined) throw new Error(`${archive}'s server-package.json names no version`);
  return found;
}

export interface OlderServerOptions {
  /** Rewrites the package's own server version, for a copy of this tree's package standing in for an older build. */
  readonly version?: string;
  /** Rewrites the daemon bundle's PROTOCOL_VERSION, for a daemon of another protocol. */
  readonly protocolVersion?: number;
  /** Drops this name from the daemon bundle's FEATURES, for a daemon built before that contract. */
  readonly withoutFeature?: string;
}

/** Unpacks `archive` into its server version's install folder on the target, as the target account; resolves with that version. */
export async function installOlderServer(fixture: SshdFixture, archive: string, options: OlderServerOptions = {}): Promise<string> {
  const version = options.version ?? packageVersion(archive);
  const copied = await runProgram('docker', ['cp', archive, `${fixture.container}:/tmp/older-server.tar.gz`]);
  if (copied.code !== 0) throw new Error(`docker cp ${archive} failed: ${copied.stderr}`);
  await fixture.sh('chmod 644 /tmp/older-server.tar.gz');
  const folder = versionFolder(version);
  await fixture.sh(`mkdir -p '${folder}' && tar -xzf /tmp/older-server.tar.gz -C '${folder}'`, 'dev');
  await fixture.sh('rm -f /tmp/older-server.tar.gz');
  // the package's own Node edits it, so no JSON or bundle text goes through sed
  const node = `'${folder}/node/node'`;
  if (options.version !== undefined) {
    // package.json and server-package.json name the app version; the daemon runs as server-package.json's serverVersion
    const appVersion = options.version.split('+')[0]!;
    const rewrite = (fields: string) => `const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));${fields};fs.writeFileSync(f,JSON.stringify(p,null,2))`;
    await fixture.sh(`${node} -e "${rewrite('p.version=process.argv[2]')}" '${folder}/package.json' '${appVersion}'`, 'dev');
    await fixture.sh(`${node} -e "${rewrite('p.version=process.argv[2];p.serverVersion=process.argv[3]')}" '${folder}/server-package.json' '${appVersion}' '${options.version}'`, 'dev');
  }
  if (options.protocolVersion !== undefined) {
    const script = `const fs=require('fs');const f=process.argv[1];const t=fs.readFileSync(f,'utf8');const m=t.match(/\\bPROTOCOL_VERSION = 1;/g)||[];if(m.length!==1)throw new Error('PROTOCOL_VERSION = 1; occurs '+m.length+' times');fs.writeFileSync(f,t.replace(/\\bPROTOCOL_VERSION = 1;/,'PROTOCOL_VERSION = '+process.argv[2]+';'))`;
    await fixture.sh(`${node} -e "${script}" '${folder}/dist/daemon.js' '${options.protocolVersion}'`, 'dev');
  }
  if (options.withoutFeature !== undefined) {
    // the bundle's one `FEATURES = [...]` list (not CORE_READ_FEATURES) loses its `, "<name>"` entry; String.fromCharCode(34)
    // keeps quotes out of sh -c
    const script = `const fs=require('fs');const f=process.argv[1];const q=String.fromCharCode(34);const t=fs.readFileSync(f,'utf8');const lists=[...t.matchAll(/\\bFEATURES = \\[/g)];if(lists.length!==1)throw new Error('FEATURES = [ occurs '+lists.length+' times');const at=lists[0].index;const end=t.indexOf(']',at);const list=t.slice(at,end)+']';const entry=', '+q+process.argv[2]+q;const left=list.split(entry+',').join(',').split(entry+']').join(']');if(list.length-left.length!==entry.length)throw new Error(process.argv[2]+' is not one entry of FEATURES');fs.writeFileSync(f,t.slice(0,at)+left+t.slice(end+1))`;
    await fixture.sh(`${node} -e "${script}" '${folder}/dist/daemon.js' '${options.withoutFeature}'`, 'dev');
  }
  return version;
}
