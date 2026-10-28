import * as path from 'node:path';
import { LINUX_TARGET } from './release-mirror';
import { runProgram, TARGET_HOME, type SshdFixture } from './sshd';

// Another app version's server on the target: unpacked where stage 1 would have installed it, so that version's launch
// finds it and starts its daemon, and the updated app meets that daemon running.

const DAEMON_SERVE = /\/\.damocles\/server\/([^/]+)-[a-z]+-(?:x64|arm64)\/node\/node .*\/dist\/daemon\.js serve\b/;

/** The install folder of `version` in the target account's default install. */
export const versionFolder = (version: string): string => `${TARGET_HOME}/.damocles/server/${version}-${LINUX_TARGET}`;

/** The version of every running daemon of the account, from its program's install folder. */
export async function daemonVersions(fixture: Pick<SshdFixture, 'userProcesses'>): Promise<string[]> {
  return (await fixture.userProcesses()).flatMap((line) => DAEMON_SERVE.exec(line)?.[1] ?? []);
}

/** `damocles-server-<version>-<target>.tar.gz` → its version. */
export function packageVersion(archive: string): string {
  const version = new RegExp(`^damocles-server-(.+)-${LINUX_TARGET}\\.tar\\.gz$`).exec(path.basename(archive))?.[1];
  if (version === undefined) throw new Error(`${archive} is no ${LINUX_TARGET} server package`);
  return version;
}

export interface OlderServerOptions {
  /** Rewrites the package's own version (package.json), for a copy of this tree's package standing in for an older one. */
  readonly version?: string;
  /** Rewrites the daemon bundle's PROTOCOL_VERSION, for a daemon of another protocol. */
  readonly protocolVersion?: number;
}

/** Unpacks `archive` into its version's install folder on the target, as the target account; resolves with that version. */
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
    const script = `const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));p.version=process.argv[2];fs.writeFileSync(f,JSON.stringify(p,null,2))`;
    await fixture.sh(`${node} -e "${script}" '${folder}/package.json' '${options.version}'`, 'dev');
  }
  if (options.protocolVersion !== undefined) {
    const script = `const fs=require('fs');const f=process.argv[1];const t=fs.readFileSync(f,'utf8');const m=t.match(/\\bPROTOCOL_VERSION = 1;/g)||[];if(m.length!==1)throw new Error('PROTOCOL_VERSION = 1; occurs '+m.length+' times');fs.writeFileSync(f,t.replace(/\\bPROTOCOL_VERSION = 1;/,'PROTOCOL_VERSION = '+process.argv[2]+';'))`;
    await fixture.sh(`${node} -e "${script}" '${folder}/dist/daemon.js' '${options.protocolVersion}'`, 'dev');
  }
  return version;
}
