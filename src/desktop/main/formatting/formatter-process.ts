import { utilityProcess } from 'electron';
import { hostEnvironment } from '../../local-services/host-environment';
import type { FormatterHostProcess } from '../../workspace/host-starters';

/** Starts dist/formatter-host.js as a utility process in root; its stdio goes nowhere, since only its replies are read. */
export function spawnFormatterHost(script: string, root: string): FormatterHostProcess {
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
