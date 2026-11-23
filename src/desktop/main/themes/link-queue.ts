// One theme install card at a time in Settings, shared by links and Settings' own Import and Install from link. A link only
// leads to core's prepare and the card; nothing installs without the card's Install (docs/invariants.md "Desktop themes").

export const MAX_WAITING_LINKS = 3;

export interface LinkQueueDeps<P extends { readonly installId: string }> {
  // core's install prepare for the link's https URL
  readonly prepare: (url: string) => Promise<P>;
  // opens Settings > Appearance with the install card on the preview of the link's `url`
  readonly show: (preview: P, url: string) => void;
  // core drops a staged install whose card never showed or was left open
  readonly cancel: (installId: string) => Promise<void>;
  // the notice for links refused while MAX_WAITING_LINKS wait: once until a waiting link leaves
  readonly refused: (url: string) => void;
  // the notice for a link whose download or preview failed
  readonly failed: (url: string, err: unknown) => void;
  readonly log: (line: string) => void;
}

export type LinkOffer = 'opening' | 'waiting' | 'dropped' | 'refused';

// The card slot: url is the https URL it installs from, when it came from one; installId once core prepared it.
interface Card {
  readonly url: string | undefined;
  installId: string | undefined;
}

/** A Settings install holding the card slot from its prepare until its card closes. */
export interface CardClaim {
  // core prepared it; the card shows
  opened(installId: string): void;
  // the prepare failed or the pick was cancelled: no card shows
  release(): void;
}

export class ThemeLinkQueue<P extends { readonly installId: string }> {
  private readonly deps: LinkQueueDeps<P>;
  // links wait until the window and core are ready
  private ready = false;
  private disposed = false;
  private card: Card | undefined;
  private readonly waiting: string[] = [];
  private refusalNoticed = false;

  constructor(deps: LinkQueueDeps<P>) {
    this.deps = deps;
  }

  /** A parsed link's https URL. */
  offer(url: string): LinkOffer {
    if (this.disposed) return 'dropped';
    if (this.card?.url === url || this.waiting.includes(url)) {
      this.deps.log(`[themes] dropped a repeated theme link to ${hostOf(url)}`);
      return 'dropped';
    }
    if (this.ready && this.card === undefined && this.waiting.length === 0) {
      this.openLink(url);
      return 'opening';
    }
    if (this.waiting.length >= MAX_WAITING_LINKS) {
      this.deps.log(`[themes] refused a theme link to ${hostOf(url)}: ${MAX_WAITING_LINKS} already wait`);
      if (!this.refusalNoticed) {
        this.refusalNoticed = true;
        this.deps.refused(url);
      }
      return 'refused';
    }
    this.waiting.push(url);
    return 'waiting';
  }

  /** The window and core are ready: a link that launched the app, or arrived meanwhile, opens now. */
  markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.advance();
  }

  /** A Settings install takes the slot; undefined while a card is open or preparing. url: the https URL it installs from. */
  claim(url?: string): CardClaim | undefined {
    if (this.disposed || this.card !== undefined) return undefined;
    const card: Card = { url, installId: undefined };
    this.card = card;
    return {
      opened: (installId) => {
        if (this.card === card) card.installId = installId;
      },
      release: () => {
        if (this.card !== card) return;
        this.card = undefined;
        this.advance();
      },
    };
  }

  /** Whether installId is the open card's. */
  isOpen(installId: string): boolean {
    return this.card?.installId !== undefined && this.card.installId === installId;
  }

  /** The open card's install, if one shows. */
  openInstall(): string | undefined {
    return this.card?.installId;
  }

  /** The card of installId closed (Install, Cancel, or Settings closing): the next waiting link opens. */
  closed(installId: string): boolean {
    if (!this.isOpen(installId)) return false;
    this.card = undefined;
    this.advance();
    return true;
  }

  /** The window is closing or the app quits: waiting links go, and the open card's install, if any, is answered. */
  dispose(): string | undefined {
    this.disposed = true;
    this.waiting.length = 0;
    const installId = this.card?.installId;
    this.card = undefined;
    return installId;
  }

  private advance(): void {
    if (!this.ready || this.disposed || this.card !== undefined) return;
    const next = this.waiting.shift();
    if (next === undefined) return;
    this.refusalNoticed = false;
    this.openLink(next);
  }

  private openLink(url: string): void {
    const card: Card = { url, installId: undefined };
    this.card = card;
    const fail = (err: unknown): void => {
      this.deps.log(`[themes] the theme link to ${hostOf(url)} opened no card: ${errorText(err)}`);
      if (this.card !== card) return;
      this.card = undefined;
      this.deps.failed(url, err);
      this.advance();
    };
    this.deps.prepare(url).then((preview) => {
      if (this.card !== card) {
        this.dropInstall(preview.installId);
        return;
      }
      card.installId = preview.installId;
      this.deps.show(preview, url);
    }).catch((err: unknown) => {
      if (this.card === card && card.installId !== undefined) this.dropInstall(card.installId);
      fail(err);
    });
  }

  private dropInstall(installId: string): void {
    this.deps.cancel(installId).catch((err: unknown) => this.deps.log(`[themes] cancelling an install no card shows failed: ${errorText(err)}`));
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// only the host is logged: a link's path and query are the sender's
function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : 'an unparsable URL';
}
