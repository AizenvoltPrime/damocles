import { utilityProcess } from 'electron';
import type { HostProcess } from './formatter-hosts';

/** The login environment main merged at startup, without Electron's own variables, which a utility process must not inherit. */
export function hostEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !/^ELECTRON_/i.test(key)) result[key] = value;
  return result;
}

/** Starts dist/formatter-host.js as a utility process in root; its stdio goes nowhere, since only its replies are read. */
export function spawnFormatterHost(script: string, root: string): HostProcess {
  const child = utilityProcess.fork(script, [], { cwd: root, env: hostEnvironment(process.env), serviceName: 'Damocles Formatter', stdio: 'ignore' });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on('message', listener),
    onExit: (listener) => child.on('exit', listener),
    kill: () => {
      child.kill();
    },
  };
}
