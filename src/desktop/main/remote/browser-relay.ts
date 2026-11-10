// A remote chat's browser tools on this computer (user.browser.tool): every address the agent names is moved to its local
// forward and checked by the client-network guard before this computer's core opens it in the host's own context, and every
// address in the answer goes back to the target's form, so the agent sees http://localhost:5173 throughout. A root file the
// remote core resolved (served) opens on this authority's served root, and shows as its file:// address.
import type { ClientNetworkPolicy } from '../../../core/browser/client-network-policy';
import { englishText, type LocalizedText } from '../../../shared/localized-text';
import type { BrowserToolAnswer } from '../../../shared/remote-user';
import { servedToFile, withAddressParts, type RelayedServedFile, type ServedMapping } from '../../../shared/served-file-url';
import { servedPathRefusal, type ServedGrant, type ServedRoot } from '../html-preview/served-roots';
import { checkClientNavigation } from './ports/client-network-guard';
import { rewriteInbound, rewriteOutbound, type ForwardingTunnels, type RewriteTunnel } from './ports/url-rewrite';

// the input fields that name an address the browser opens; DesignParityCapture is core's PARITY_CAPTURE_TOOL
const URL_FIELDS: Readonly<Record<string, string>> = { BrowserOpen: 'url', BrowserNavigate: 'url', BrowserTabs: 'url', DesignParityCapture: 'url' };
// the tools a remote core sends a served root file with
const SERVED_TOOLS: ReadonlySet<string> = new Set(['BrowserOpen', 'BrowserNavigate']);
// its paths name files on the target, which this computer's browser cannot read
const TARGET_PATH_TOOLS: ReadonlySet<string> = new Set(['BrowserUpload']);

export interface BrowserRelayDeps {
  readonly authority: string;
  // a live chat view of this authority that main shows; the local core holds a proxy for it once attach settles
  readonly attachView: (viewId: string) => Promise<void>;
  readonly tunnels: () => ForwardingTunnels;
  readonly policy: () => ClientNetworkPolicy;
  // ServedRoots for this authority: a grant publishes its port into policy() before it resolves
  readonly served: {
    grant(request: { readonly root: ServedRoot; readonly viewId: string; readonly displayRoot: string }): Promise<ServedGrant | { readonly refused: string }>;
    mappings(): readonly ServedMapping[];
  };
  readonly run: (params: { readonly authority: string; readonly viewId: string; readonly scope: string; readonly tool: string; readonly input: unknown }, signal: AbortSignal) => Promise<BrowserToolAnswer>;
}

const refused = (text: string): BrowserToolAnswer => ({ content: [{ type: 'text', text }], isError: true });

const FORWARD_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

// whether the address's origin is a forward's local listener; its query and fragment are the user's and stay as typed
function onForward(url: string, tunnels: readonly RewriteTunnel[]): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  const port = parsed.port || DEFAULT_PORTS[parsed.protocol];
  return FORWARD_HOSTS.has(parsed.hostname) && tunnels.some((tunnel) => String(tunnel.localPort) === port);
}

// whether the address's origin is one of the authority's served roots, which listen on 127.0.0.1 and take localhost as Host
function onServedRoot(url: string, servedPorts: readonly number[]): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && servedPorts.includes(Number(parsed.port));
}

// The one-time URL of the root file a remote core resolved, on this authority's server of that root, carrying the query and
// fragment of the file:// address the agent wrote; the file itself is only the one the core named.
async function servedUrl(deps: BrowserRelayDeps, viewId: string, served: RelayedServedFile, address: string): Promise<{ readonly url: string } | { readonly refused: string }> {
  const root: ServedRoot = served.kind === 'project' ? { kind: 'project' } : { kind: 'design', designId: served.designId };
  const refusal = servedPathRefusal(root, served.relPath);
  if (refusal !== undefined) return { refused: refusal };
  const grant = await deps.served.grant({ root, viewId, displayRoot: served.displayRoot });
  return 'refused' in grant ? { refused: grant.refused } : { url: withAddressParts(grant.open(served.relPath), address) };
}

// a glob's concrete origin: scheme, host and port before its first wildcard, with nothing glob-like inside it
const PATTERN_ORIGIN = /^((?:https?|wss?):\/\/[^/*?{}[\]]+)(\/.*)?$/;
const GLOB_CHARS = /[*?{}[\]]/;

/**
 * An intercept pattern's concrete literal origin, rewritten as the agent's other addresses are (rewriteInbound: a target
 * loopback port or a forwarded target moves to its forward); a regex and a pattern whose origin holds a wildcard stay as written.
 */
export async function interceptPattern(pattern: string, authority: string, tunnels: ForwardingTunnels): Promise<string> {
  const wildcard = pattern.search(GLOB_CHARS);
  const literal = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
  const match = PATTERN_ORIGIN.exec(literal);
  // the origin ends where its path starts; a wildcard before that leaves the origin open (http://localhost:*/api)
  if (!match || (match[2] === undefined && wildcard >= 0) || !URL.canParse(match[1]!)) return pattern;
  // userinfo or a backslash makes the URL parser read another host than the pattern shows, so such an origin is not concrete
  if (/[@\\]/.test(match[1]!)) return pattern;
  const origin = new URL(match[1]!);
  const written = `${origin.protocol}//${origin.host}/`;
  const local = await rewriteInbound(written, authority, tunnels);
  // a pattern that names no forward stays exactly as written
  if (local === written) return pattern;
  const moved = new URL(local);
  return `${moved.protocol}//${moved.host}${pattern.slice(match[1]!.length)}`;
}

/**
 * An address typed into a remote chat's page tab, in the local form the page opens: a target loopback address moves to its
 * forward, and the local address of a forward or of a served root (the page's own, entered again) stays there, not on a
 * target port of the same number; then the client-network guard.
 */
export async function typedRemoteAddress(url: string, authority: string, tunnels: ForwardingTunnels, policy: () => ClientNetworkPolicy, servedPorts: readonly number[]): Promise<{ readonly allowed: true; readonly url: string } | { readonly allowed: false; readonly reason: LocalizedText }> {
  const local = onForward(url, tunnels.list(authority)) || onServedRoot(url, servedPorts) ? url : await rewriteInbound(url, authority, tunnels);
  const verdict = await checkClientNavigation(local, policy());
  return verdict.allowed ? { allowed: true, url: local } : verdict;
}

export async function relayBrowserTool(deps: BrowserRelayDeps, request: { readonly viewId: string; readonly scope: string; readonly tool: string; readonly input: unknown; readonly served?: RelayedServedFile }, signal: AbortSignal): Promise<BrowserToolAnswer> {
  if (TARGET_PATH_TOOLS.has(request.tool)) return refused(`${request.tool} is not available in a chat on a remote host: its paths name files on the host, and the browser runs on the user's computer.`);
  if (request.served && !SERVED_TOOLS.has(request.tool)) return refused(`${request.tool.slice(0, 64)} opens no project or design file; only BrowserOpen and BrowserNavigate do.`);
  // a call for a view this computer does not show is refused before it forwards anything
  await deps.attachView(request.viewId);
  let input = request.input;
  const field = URL_FIELDS[request.tool];
  const address = field !== undefined && typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[field] : undefined;
  if (field !== undefined && typeof address === 'string') {
    // an address the agent wrote is always in target form, so only the URL main builds for a served file skips the rewrite
    let local: string;
    if (request.served) {
      const served = await servedUrl(deps, request.viewId, request.served, address);
      if ('refused' in served) return refused(served.refused);
      local = served.url;
    } else {
      local = await rewriteInbound(address, deps.authority, deps.tunnels());
    }
    // the policy is read after the inbound forward, which published it to the local core first
    const verdict = await checkClientNavigation(local, deps.policy());
    // the guard's reason would name the served root's loopback port, which never reaches the target
    if (!verdict.allowed) return refused(request.served ? 'This computer\'s browser for this host could not reach the server of that file.' : englishText(verdict.reason));
    input = { ...(input as Record<string, unknown>), [field]: local };
  }
  const pattern = request.tool === 'BrowserIntercept' && typeof input === 'object' && input !== null ? (input as Record<string, unknown>)['pattern'] : undefined;
  if (typeof pattern === 'string') input = { ...(input as Record<string, unknown>), pattern: await interceptPattern(pattern, deps.authority, deps.tunnels()) };
  const answer = await deps.run({ authority: deps.authority, viewId: request.viewId, scope: request.scope, tool: request.tool, input }, signal);
  const tunnels = deps.tunnels().list(deps.authority);
  const mappings = deps.served.mappings();
  // served URLs first, while every port is still a local one: a target port in the rewritten text may equal a served port
  return { ...answer, content: answer.content.map((block) => (block.type === 'text' ? { type: 'text', text: rewriteOutbound(servedToFile(block.text, mappings), tunnels) } : block)) };
}
