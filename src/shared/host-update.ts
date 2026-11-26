/** A host's pending server switch, which every surface (update strip, host card, badge, composer card) reads. */
export type HostUpdate = HostUpdateFacts & (
  // waiting: a switch was asked for and follows once nothing blocks it
  | { readonly phase: 'offer' | 'waiting' | 'switching'; readonly outdated?: undefined }
  // this app is older than the host needs: a newer daemon runs, or the host's security floor is above this app
  | { readonly phase: 'appOutdated'; readonly outdated: 'runs' | 'floor' }
);

interface HostUpdateFacts {
  // compatible: a daemon of this protocol and another build; otherProtocol: another PROTOCOL_VERSION
  readonly source: 'compatible' | 'otherProtocol';
  // appVersionOf the daemon's serverVersion, e.g. "3.7.0"; the floor itself when outdated is 'floor'
  readonly serverVersion: string;
  // this app's version
  readonly targetVersion: string;
  // runs of kind 'chat', every computer's
  readonly runningAgents: number;
  // runs of kind 'terminal'
  readonly runningTerminals: number;
  // pending damocles --wait requests, every computer's, which hold the switch as agents do; absent when none
  readonly cliWaits?: number;
  // the daemon serves control.handOver, so its terminals outlive the switch
  readonly terminalsSurvive: boolean;
  // connected computers besides this one; absent when unknown
  readonly otherDevices?: number;
  // epoch ms the bounded drain ends
  readonly drainEndsAt?: number;
  // epoch ms this app first saw the switch pending, kept across relaunches
  readonly waitingSince: number;
  // a required update: its deadline (epoch ms) and whether the final countdown runs
  readonly required?: { readonly deadline: number; readonly countdown: boolean };
}
