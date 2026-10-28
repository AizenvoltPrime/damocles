import { promises as fs, mkdirSync, copyFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { confineExisting, type Project } from '../../local-services/confine';
import type { TerminalLinkKind } from '../../preload/terminal-channels';
import type { TerminalView } from '../../pty-host/protocol';
import type { HostStarters, PtyHostProcess } from '../host-starters';
import { detectProfiles, systemProfileProbe, windowsBuildNumber, type TerminalProfile } from './profiles';
import { shellIntegrationInjection, type Injection } from './shell-integration-injection';
import { terminalEnvironment } from './terminal-env';

export interface ShellInjectionRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly nonce: string;
  // the environment the shell gets otherwise
  readonly env: Readonly<Record<string, string>>;
}

// A terminal the backend's host keeps running for a client that attaches again.
export interface LiveTerminal {
  readonly id: string;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  // a daemon's terminal: what its spawning client sent, so another client can show it
  readonly view?: TerminalView;
}

// Groups, names, OSC 633 parsing and its nonce check stay in main.
export interface TerminalBackend {
  startHost(): PtyHostProcess;
  detectProfiles(): Promise<TerminalProfile[]>;
  // the login environment without ELECTRON_* and the scripts' state, LANG following locale when it is not UTF-8
  environment(locale: string): Promise<Record<string, string>>;
  // the shell's integration args and environment, its startup files copied; undefined when VS Code's rules inject nothing
  // into it or the copy failed
  injection(request: ShellInjectionRequest): Promise<Omit<Injection, 'filesToCopy'> | undefined>;
  // the terminals kept from before this client attached; a serialize request for one attaches it again
  list(): Promise<readonly LiveTerminal[]>;
  // what an existing path inside the project is after every link is followed; null for anything else
  linkKind(project: Project, relativePath: string): Promise<TerminalLinkKind | null>;
  // the host's Windows build, which its pty host's screens and its terminals' views give xterm; null off Windows
  windowsBuild(): Promise<number | null>;
}

export interface TerminalBackendDeps {
  readonly starters: Pick<HostStarters, 'startPtyHost'>;
  readonly platform: NodeJS.Platform;
  // the app's own shell-integration scripts (resources, unpacked)
  readonly scriptsDir: string;
  // zsh's ZDOTDIR in the user's app data
  readonly zshDotDir: string;
  readonly homedir: string;
  // the login environment the host merged at startup
  readonly env: NodeJS.ProcessEnv;
  readonly log: (line: string) => void;
  // the synchronous copy of zsh's startup files (throws on failure)
  readonly copyFiles?: (files: ReadonlyArray<{ readonly source: string; readonly dest: string }>) => void;
}

// A few kilobytes, copied only as a zsh starts, as VS Code does; the folder is the user's alone.
function copyFiles(files: ReadonlyArray<{ readonly source: string; readonly dest: string }>): void {
  for (const { source, dest } of files) {
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(source, dest);
  }
}

export function createTerminalBackend(deps: TerminalBackendDeps): TerminalBackend {
  return {
    startHost: () => deps.starters.startPtyHost(),
    detectProfiles: () => detectProfiles(systemProfileProbe(deps.env, deps.log)),
    environment: async (locale) => terminalEnvironment(deps.env, { locale, zshDotDir: deps.zshDotDir }),
    async injection(request) {
      const injection = shellIntegrationInjection({ ...request, platform: deps.platform, scriptsDir: deps.scriptsDir, zshDotDir: deps.zshDotDir, homedir: deps.homedir });
      if (!injection?.filesToCopy) return injection;
      try {
        (deps.copyFiles ?? copyFiles)(injection.filesToCopy);
      } catch (err) {
        deps.log(`[terminal] starting ${request.file} without shell integration: its startup files could not be copied: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
      return { args: injection.args, env: injection.env };
    },
    // a local pty host ends with the app, so nothing outlives it to list
    list: async () => [],
    windowsBuild: async () => (deps.platform === 'win32' ? windowsBuildNumber(os.release(), deps.platform) : null),
    async linkKind(project, relativePath) {
      const confined = await confineExisting(project, relativePath);
      if (!confined.ok) {
        if (confined.reason === 'failed') deps.log(`[terminal] a link inside ${project.name} could not be resolved`);
        return null;
      }
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(confined.path);
      } catch (err) {
        // removed since the realpath
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      if (stat.isFile()) return 'file';
      return stat.isDirectory() ? 'folder' : null;
    },
  };
}
