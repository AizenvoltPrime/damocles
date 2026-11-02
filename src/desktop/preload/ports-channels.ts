// The Ports section's channels, shared by the shell preload, main and (as types only) the shell app. Main asks for every text
// input itself (askInput) and names rows by keys it issued; the shell passes projectKey and key back verbatim.

export const PORTS_CHANNELS = {
  // renderer → main, invoke
  // { hostId } → PortsView | null (null: not a saved SSH host)
  get: 'damocles:ports:get',
  // { projectKey } → void: asks the target, then a label, and forwards it; resolves when done or cancelled
  forward: 'damocles:ports:forward',
  // { projectKey, key } → void: the Forward action of a detected or ignored row, and the retry of a failed one
  forwardDetected: 'damocles:ports:forward-detected',
  // { projectKey, key } → void
  stop: 'damocles:ports:stop',
  // { projectKey, key } → void: asks for the label, the current one prefilled; an empty answer clears it
  setLabel: 'damocles:ports:set-label',
  // { projectKey, key } → void: asks for the port and asks again with the reason while it is refused; Escape leaves it
  changeLocalPort: 'damocles:ports:change-local-port',
  // { projectKey, port, onDetect } → void
  setOnDetect: 'damocles:ports:set-on-detect',
  // { projectKey, key } → void: a browser tab of the project's selected chat
  openInPane: 'damocles:ports:open-in-pane',
  // { projectKey, key } → void
  openInBrowser: 'damocles:ports:open-in-browser',
  // { projectKey, key } → void: http://localhost:<local port> on the clipboard
  copyAddress: 'damocles:ports:copy-address',
  // { projectKey } → void: the host forwards every listening port again, and the fallback stays off for it
  undoFallback: 'damocles:ports:undo-fallback',
  // main → renderer: PortsView of one host, on every change of it
  state: 'damocles:ports:state',
} as const;

export const ON_DETECT = ['notify', 'openPane', 'openBrowser', 'silent', 'ignore'] as const;
export type OnDetect = (typeof ON_DETECT)[number];
export const MAX_PORT_LABEL_CHARS = 100;

export interface PortRow {
  readonly key: string;
  // 'localhost' for a loopback target, else as typed or bound
  readonly remoteHost: string;
  readonly remotePort: number;
  // set while forwarded
  readonly localPort?: number;
  readonly label?: string;
  // "node (npm run dev)"
  readonly processLabel?: string;
  readonly state: 'forwarded' | 'detected' | 'ignored' | 'error';
  readonly error?: 'listenFailed';
  // connections the forward carries now; above 0 the row's dot is green
  readonly liveConnections: number;
  readonly origin: 'auto' | 'manual' | 'output';
  // exact port over range, 'notify' when neither is set
  readonly onDetect: OnDetect;
  // WSL forwards this port to this computer itself: no tunnel, and localPort equals remotePort
  readonly viaWsl?: true;
}

export interface PortsView {
  readonly hostId: string;
  readonly autoForwardMode: 'all' | 'outputOnly';
  // damocles.desktop.remote.autoForwardPorts
  readonly autoForward: boolean;
  readonly connected: boolean;
  // by remote port, then remote host
  readonly rows: readonly PortRow[];
}

export interface DamoclesPortsApi {
  get(hostId: string): Promise<PortsView | null>;
  onState(listener: (view: PortsView) => void): () => void;
  forward(projectKey: string): Promise<void>;
  forwardDetected(projectKey: string, key: string): Promise<void>;
  stop(projectKey: string, key: string): Promise<void>;
  setLabel(projectKey: string, key: string): Promise<void>;
  changeLocalPort(projectKey: string, key: string): Promise<void>;
  setOnDetect(projectKey: string, port: number, onDetect: OnDetect): Promise<void>;
  openInPane(projectKey: string, key: string): Promise<void>;
  openInBrowser(projectKey: string, key: string): Promise<void>;
  copyAddress(projectKey: string, key: string): Promise<void>;
  undoFallback(projectKey: string): Promise<void>;
}
