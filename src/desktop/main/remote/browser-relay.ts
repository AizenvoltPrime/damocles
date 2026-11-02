// A remote chat's browser tools on this computer (user.browser.tool): every address the agent names is moved to its local
// forward and checked by the client-network guard before this computer's core opens it in the host's own context, and every
// address in the answer goes back to the target's form, so the agent sees http://localhost:5173 throughout.
import type { ClientNetworkPolicy } from '../../../core/browser/client-network-policy';
import { englishText, type LocalizedText } from '../../../shared/localized-text';
import type { BrowserToolAnswer } from '../../../shared/remote-user';
import { checkClientNavigation } from './ports/client-network-guard';
import { rewriteInbound, rewriteOutbound, type ForwardingTunnels, type RewriteTunnel } from './ports/url-rewrite';

// the input fields that name an address the browser opens
const URL_FIELDS: Readonly<Record<string, string>> = { BrowserOpen: 'url', BrowserNavigate: 'url', BrowserTabs: 'url' };
// its paths name files on the target, which this computer's browser cannot read
const TARGET_PATH_TOOLS: ReadonlySet<string> = new Set(['BrowserUpload']);

export interface BrowserRelayDeps {
  readonly authority: string;
  // a live chat view of this authority that main shows; the local core holds a proxy for it once attach settles
  readonly attachView: (viewId: string) => Promise<void>;
  readonly tunnels: () => ForwardingTunnels;
  readonly policy: () => ClientNetworkPolicy;
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
 * forward, and the local address of a forward (the page's own, entered again) stays on that forward, not on a target port
 * of the same number; then the client-network guard.
 */
export async function typedRemoteAddress(url: string, authority: string, tunnels: ForwardingTunnels, policy: () => ClientNetworkPolicy): Promise<{ readonly allowed: true; readonly url: string } | { readonly allowed: false; readonly reason: LocalizedText }> {
  const local = onForward(url, tunnels.list(authority)) ? url : await rewriteInbound(url, authority, tunnels);
  const verdict = await checkClientNavigation(local, policy());
  return verdict.allowed ? { allowed: true, url: local } : verdict;
}

export async function relayBrowserTool(deps: BrowserRelayDeps, request: { readonly viewId: string; readonly scope: string; readonly tool: string; readonly input: unknown }, signal: AbortSignal): Promise<BrowserToolAnswer> {
  if (TARGET_PATH_TOOLS.has(request.tool)) return refused(`${request.tool} is not available in a chat on a remote host: its paths name files on the host, and the browser runs on the user's computer.`);
  // a call for a view this computer does not show is refused before it forwards anything
  await deps.attachView(request.viewId);
  let input = request.input;
  const field = URL_FIELDS[request.tool];
  const address = field !== undefined && typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[field] : undefined;
  if (field !== undefined && typeof address === 'string') {
    const local = await rewriteInbound(address, deps.authority, deps.tunnels());
    // the policy is read after the inbound forward, which published it to the local core first
    const verdict = await checkClientNavigation(local, deps.policy());
    if (!verdict.allowed) return refused(englishText(verdict.reason));
    input = { ...(input as Record<string, unknown>), [field]: local };
  }
  const pattern = request.tool === 'BrowserIntercept' && typeof input === 'object' && input !== null ? (input as Record<string, unknown>)['pattern'] : undefined;
  if (typeof pattern === 'string') input = { ...(input as Record<string, unknown>), pattern: await interceptPattern(pattern, deps.authority, deps.tunnels()) };
  const answer = await deps.run({ authority: deps.authority, viewId: request.viewId, scope: request.scope, tool: request.tool, input }, signal);
  const tunnels = deps.tunnels().list(deps.authority);
  return { ...answer, content: answer.content.map((block) => (block.type === 'text' ? { type: 'text', text: rewriteOutbound(block.text, tunnels) } : block)) };
}
