// Links a target asks this computer to open (docs/invariants.md "Links from targets"): checked, their loopback ports
// forwarded first, and opened after the user's consent unless the user clicked them.
import type { Disposable } from '../../../platform/disposable';
import { ForwardLimitError, MAX_FORWARDS_PER_HOST, PortRefusedError, type PortRefusal, type TunnelManager } from './ports/tunnels';
import { isTargetLoopbackHost, rewriteInbound } from './ports/url-rewrite';

export const MAX_LINK_BYTES: number = 8 * 1024;

// A target looping on BROWSER raises at most this many notices of one host at once; each holds a sticky toast.
export const MAX_PENDING_LINKS_PER_HOST = 5;

// An OAuth server compares the redirect exactly, so this query value keeps its port and needs that local port free.
const REDIRECT_PARAM = 'redirect_uri';
const CONTROL = /\p{Cc}/u;
// the longest origin a refusal's log line names
const MAX_LOGGED_ORIGIN = 200;

export type LinkRefusal = 'invalid' | 'portInUse' | 'portRefused' | 'forwardFailed' | 'tooMany' | 'openFailed';

/** A link this computer will not open; its message is localized for the user. */
export class LinkRefusedError extends Error {
  override readonly name: string = 'LinkRefusedError';
  readonly code: LinkRefusal;

  constructor(code: LinkRefusal, message: string) {
    super(message);
    this.code = code;
  }
}

export type LinkAnswer = 'open' | 'dismissed';

/** A link notice: answered 'open' only by its Open; withdrawn, its toast goes and it answers 'dismissed'. */
export interface LinkRequest {
  readonly answer: Promise<LinkAnswer>;
  withdraw(): void;
}

export interface OpenUrlDeps {
  // the authority's forwarding: an existing forward of the port, else a new one (PortForwarding.forwardingFor)
  readonly tunnels: (authority: string) => Pick<TunnelManager, 'forward' | 'list'>;
  // fires synchronously as one of the authority's forwards starts, moves or stops (TunnelManager.onDidChange), with the local
  // ports of its forwards then
  readonly onForwardsChanged: (listener: (authority: string, localPorts: readonly number[]) => void) => Disposable;
  // the host's switch "Open links from <host>'s terminals without asking"
  readonly opensTerminalLinks: (authority: string) => boolean;
  // the link notice, naming the host as this computer's host store does; url is exactly what Open opens
  readonly askToOpen: (request: { readonly authority: string; readonly url: string }) => LinkRequest;
  // ShellService.openExternal
  readonly openExternal: (url: string) => Promise<boolean>;
  // the Ports section's text for a local port it refuses (PortsController.refusalText)
  readonly refusalText: (code: PortRefusal, port: number) => string;
  readonly hostName: (authority: string) => string;
  readonly warn: (message: string) => void;
  readonly t: (message: string, ...args: string[]) => string;
  readonly log: (line: string) => void;
}

// the target's own loopback, as the browser relay's rewrite reads it, so no form of it opens this computer's loopback
// unforwarded: a URL with no port, or its scheme's default port, forwards that port
function targetLoopback(url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:') && isTargetLoopbackHost(url.hostname);
}

function portOf(url: URL): number {
  return url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

// The href this computer opens and the local ports of the forwards it reaches.
interface PreparedLink {
  readonly href: string;
  readonly localPorts: readonly number[];
}

// A notice waiting for its answer, holding one of its host's MAX_PENDING_LINKS_PER_HOST places.
interface PendingLink {
  // the forwards its href reaches; one that stops or moves withdraws the notice, whose Open would reach something else
  forwards: readonly number[];
  request: LinkRequest | undefined;
}

export class OpenUrl {
  private readonly deps: OpenUrlDeps;
  private readonly pending = new Map<string, Set<PendingLink>>();

  constructor(deps: OpenUrlDeps) {
    this.deps = deps;
    deps.onForwardsChanged((authority, localPorts) => this.forwardsChanged(authority, new Set(localPorts)));
  }

  /**
   * A URL from a terminal's BROWSER helper. Resolves once it opened, or once its notice shows (the host's switch off), so the
   * program that asked is not held while the notice waits; rejects with LinkRefusedError for a link that cannot open.
   */
  async terminalBrowser(authority: string, url: string): Promise<void> {
    if (this.deps.opensTerminalLinks(authority)) {
      await this.open((await this.prepare(authority, url)).href);
      return;
    }
    const place = this.hold(authority);
    let link: PreparedLink;
    try {
      link = await this.prepare(authority, url);
    } catch (err) {
      this.letGo(authority, place);
      throw err;
    }
    this.consent(authority, link, place).catch((err: unknown) => this.report(err));
  }

  /** A remote core's own shell.openExternal: always the notice, whatever the host's switch says. */
  async coreOpenExternal(authority: string, url: string): Promise<boolean> {
    let place: PendingLink | undefined;
    try {
      place = this.hold(authority);
      return await this.consent(authority, await this.prepare(authority, url), place);
    } catch (err) {
      if (!(err instanceof LinkRefusedError)) throw err;
      this.letGo(authority, place);
      // the host's waiting notices already show; a warning for each request past them would flood the popup again
      if (err.code === 'tooMany') this.deps.log(`[links] ${authority}: a remote core's link was refused, ${MAX_PENDING_LINKS_PER_HOST} of its notices wait`);
      else this.report(err);
      return false;
    }
  }

  /** A link the user clicked in a remote terminal or a remote chat page: forwarded like the others, opened with no notice. */
  async userClick(authority: string, url: string): Promise<boolean> {
    try {
      return await this.open((await this.prepare(authority, url)).href);
    } catch (err) {
      if (!(err instanceof LinkRefusedError)) throw err;
      this.report(err);
      return false;
    }
  }

  /** Forget host: its waiting notices go, since nothing of the host opens any more. */
  forgetHost(authority: string): void {
    for (const place of this.pending.get(authority) ?? []) place.request?.withdraw();
  }

  // The href this computer opens: canonical, so all ASCII (punycode host, percent-encoded path), loopback ports forwarded.
  private async prepare(authority: string, url: string): Promise<PreparedLink> {
    if (Buffer.byteLength(url, 'utf8') > MAX_LINK_BYTES || CONTROL.test(url) || !URL.canParse(url)) throw this.invalid(url);
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw this.invalid(url);
    const tunnels = this.deps.tunnels(authority);
    const localPorts: number[] = [];
    if (parsed.search.length > 1) parsed.search = await this.forwardQuery(authority, parsed.search.slice(1), tunnels, localPorts);
    if (!targetLoopback(parsed)) return { href: parsed.href, localPorts };
    const href = await this.forwarding(authority, portOf(parsed), () => rewriteInbound(parsed.href, authority, tunnels));
    localPorts.push(portOf(new URL(href)));
    return { href, localPorts };
  }

  // Each query value naming the target's loopback is forwarded; every other pair stays byte for byte as written.
  private async forwardQuery(authority: string, query: string, tunnels: Pick<TunnelManager, 'forward' | 'list'>, localPorts: number[]): Promise<string> {
    const pairs: string[] = [];
    for (const pair of query.split('&')) {
      const separator = pair.indexOf('=');
      const [name, value] = [...new URLSearchParams(pair)][0] ?? [];
      if (separator < 0 || value === undefined || !URL.canParse(value) || !targetLoopback(new URL(value))) {
        pairs.push(pair);
        continue;
      }
      const port = portOf(new URL(value));
      if (name === REDIRECT_PARAM) {
        await this.forwardExactly(authority, port, tunnels);
        localPorts.push(port);
        pairs.push(pair);
        continue;
      }
      const local = await this.forwarding(authority, port, () => rewriteInbound(value, authority, tunnels));
      localPorts.push(portOf(new URL(local)));
      pairs.push(`${pair.slice(0, separator)}=${encodeURIComponent(local)}`);
    }
    return pairs.join('&');
  }

  private async forwardExactly(authority: string, port: number, tunnels: Pick<TunnelManager, 'forward' | 'list'>): Promise<void> {
    const { localPort } = await this.forwarding(authority, port, () => tunnels.forward(authority, { host: 'localhost', port }, { localPort: port, requireLocalPort: true }));
    // an earlier forward of the same remote port may already listen on another local port
    if (localPort !== port) throw this.portRefused(authority, 'inUse', port);
  }

  // A forward this link needs and cannot have is a refusal the user is told, never a link that silently does nothing.
  private async forwarding<T>(authority: string, port: number, forward: () => Promise<T>): Promise<T> {
    try {
      return await forward();
    } catch (err) {
      if (err instanceof PortRefusedError) throw this.portRefused(authority, err.code, err.port);
      if (err instanceof ForwardLimitError) {
        throw new LinkRefusedError('forwardFailed', this.deps.t('{0} already has {1} forwarded ports, the most Damocles keeps for one host. Stop forwarding one to forward another.', this.deps.hostName(authority), String(MAX_FORWARDS_PER_HOST)));
      }
      this.deps.log(`[links] ${authority}: port ${port} could not be forwarded for a link: ${err instanceof Error ? err.message : String(err)}`);
      throw new LinkRefusedError('forwardFailed', this.deps.t('Port {0} of {1} could not be forwarded to this computer, so the link did not open.', String(port), this.deps.hostName(authority)));
    }
  }

  // One of the host's notice places, or a refusal once MAX_PENDING_LINKS_PER_HOST of its notices wait.
  private hold(authority: string): PendingLink {
    const places = this.pending.get(authority) ?? new Set<PendingLink>();
    if (places.size >= MAX_PENDING_LINKS_PER_HOST) {
      throw new LinkRefusedError('tooMany', this.deps.t('{0} already has {1} links waiting for an answer. Answer one to open another.', this.deps.hostName(authority), String(MAX_PENDING_LINKS_PER_HOST)));
    }
    const place: PendingLink = { forwards: [], request: undefined };
    places.add(place);
    this.pending.set(authority, places);
    return place;
  }

  private letGo(authority: string, place: PendingLink | undefined): void {
    const places = this.pending.get(authority);
    if (!places || !place) return;
    places.delete(place);
    if (places.size === 0) this.pending.delete(authority);
  }

  private async consent(authority: string, link: PreparedLink, place: PendingLink): Promise<boolean> {
    try {
      // only a port the TunnelManager lists is a forward that can stop; a WSL port reached on its own number is none
      const live = new Set(this.deps.tunnels(authority).list(authority).map((tunnel) => tunnel.localPort));
      place.forwards = link.localPorts.filter((port) => live.has(port));
      place.request = this.deps.askToOpen({ authority, url: link.href });
      return (await place.request.answer) === 'open' && (await this.open(link.href));
    } finally {
      this.letGo(authority, place);
    }
  }

  private forwardsChanged(authority: string, live: ReadonlySet<number>): void {
    const places = this.pending.get(authority);
    if (!places) return;
    for (const place of places) {
      if (place.forwards.some((port) => !live.has(port))) place.request?.withdraw();
    }
  }

  private async open(href: string): Promise<boolean> {
    if (await this.deps.openExternal(href)) return true;
    throw new LinkRefusedError('openFailed', this.deps.t('Damocles could not open the page in the system browser.'));
  }

  private invalid(url: string): LinkRefusedError {
    // a URL can carry tokens anywhere after its origin, so only the scheme and origin are logged
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    const named = parsed ? `${parsed.protocol} ${parsed.origin.slice(0, MAX_LOGGED_ORIGIN)}` : 'text that is no URL';
    this.deps.log(`[links] refused a link that is not an http or https URL of at most ${MAX_LINK_BYTES} bytes without control characters: ${named}`);
    return new LinkRefusedError('invalid', this.deps.t('Only http and https links of at most 8 KiB with no control characters open on this computer.'));
  }

  private portRefused(authority: string, code: PortRefusal, port: number): LinkRefusedError {
    this.deps.log(`[links] ${authority}: local port ${port} for a link cannot be used: ${code}`);
    if (code === 'inUse') return new LinkRefusedError('portInUse', this.deps.t('Port {0} is in use on this computer. Free it and try again.', String(port)));
    return new LinkRefusedError('portRefused', this.deps.refusalText(code, port));
  }

  private report(err: unknown): void {
    if (err instanceof LinkRefusedError) this.deps.warn(err.message);
    else this.deps.log(`[links] a link did not open: ${err instanceof Error ? err.message : String(err)}`);
  }
}
