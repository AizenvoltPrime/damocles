import type { SessionFileWrite } from '../../../core/pi-session/session-store/session-file-write';
import type { CoreClient } from '../core-client';
import { CoreNotRunningError } from '../core-host';
import { SESSION_FILES_FEATURE } from '../workspace/remote-workspace';

/** Why an authority's engine cannot take a request: it is stopped or halted, its host is not connected, or its daemon predates SESSION_FILES_FEATURE. */
export type EngineAbsence = 'stopped' | 'notConnected' | 'unsupported';

export class EngineUnavailableError extends Error {
  readonly absence: EngineAbsence;

  constructor(authority: string, absence: EngineAbsence) {
    super(`The engine of ${authority} cannot take the request (${absence})`);
    this.name = 'EngineUnavailableError';
    this.absence = absence;
  }
}

/** Each authority's engine, the only writer of its session files (docs/invariants.md "Session store"). */
export interface SessionFileEngines {
  write(authority: string, filePath: string, bytes: Uint8Array, expectedSha256: string | null): Promise<SessionFileWrite>;
}

interface EngineHost {
  halted(): boolean;
  run<T>(label: string, work: (core: { readonly client: CoreClient }) => Promise<T>): Promise<T>;
}

export interface SessionFileEnginesDeps {
  // this computer's core host, or a host's; undefined for a host main holds no core of
  readonly host: (authority: string) => EngineHost | undefined;
  // the features a host's connection lists; undefined while it is not connected
  readonly features: (authority: string) => readonly string[] | undefined;
}

export function sessionFileEngines(deps: SessionFileEnginesDeps): SessionFileEngines {
  return {
    async write(authority, filePath, bytes, expectedSha256) {
      if (authority !== 'local') {
        const features = deps.features(authority);
        if (!features) throw new EngineUnavailableError(authority, 'notConnected');
        if (!features.includes(SESSION_FILES_FEATURE)) throw new EngineUnavailableError(authority, 'unsupported');
      }
      const host = deps.host(authority);
      if (!host) throw new EngineUnavailableError(authority, 'notConnected');
      if (host.halted()) throw new EngineUnavailableError(authority, 'stopped');
      try {
        return await host.run('Session file save', (core) => core.client.writeSessionFile(filePath, bytes, expectedSha256));
      } catch (err) {
        if (err instanceof CoreNotRunningError) throw new EngineUnavailableError(authority, 'stopped');
        throw err;
      }
    },
  };
}
