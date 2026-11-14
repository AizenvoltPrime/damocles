import type { ForgeFlavor, ForgeKind, ForgeSignInRoute } from '../../shared/forge/accounts';
import type { LocalizedText } from '../../shared/localized-text';

export type { ForgeFlavor, ForgeKind, ForgeSignInRoute };

// equals FORGE_SHOW_AVATARS_SETTING in src/desktop/local-services/desktop-configuration.ts
export const FORGE_SHOW_AVATARS_SETTING = 'damocles.desktop.forge.showAvatars';
/** Application scope: read tools may name another repository on the project's server. */
export const FORGE_AGENT_READ_ANY_REPOSITORY_SETTING = 'damocles.desktop.forge.agentReadAnyRepository';
/** Application scope: the CI chip, the job list and their polling; off watches nothing. */
export const FORGE_CI_STATUS_SETTING = 'damocles.desktop.forge.ciStatus';
/** Application scope: the servers' branch protection joins the protected-branch question; off reads none. */
export const FORGE_BRANCH_PROTECTION_SETTING = 'damocles.desktop.forge.branchProtection';
/** Application scope: 'https' or 'ssh', the clone URL the clone picker uses. */
export const FORGE_CLONE_PROTOCOL_SETTING = 'damocles.desktop.forge.cloneProtocol';

/** The built-in servers' ids, which are also their web hosts. */
export const GITHUB_COM = 'github.com';
export const GITLAB_COM = 'gitlab.com';

/** One record of servers.json (docs/invariants.md "GitHub and GitLab accounts"). */
export interface ServerRecord {
  /** The canonical URL without its scheme: host[:port][/path]. */
  readonly id: string;
  readonly kind: ForgeKind;
  readonly flavor: ForgeFlavor;
  readonly name?: string;
  /** The hosts git reaches this server by: managed, matched to remotes and answered by credentials. */
  readonly gitHosts: readonly string[];
  /** Hosts learned from the server's clone URLs, none of the above until the user confirms one. */
  readonly pendingGitHosts?: readonly string[];
  /** Learned hosts the user dismissed, never proposed again. */
  readonly dismissedGitHosts?: readonly string[];
  readonly oauth?: { readonly clientId: string };
  readonly version?: string;
  readonly versionCheckedAt?: number;
  /** GHES: the newest REST API version both sides support. */
  readonly apiVersion?: string;
  readonly addedAt: number;
}

/** One record of accounts.json; the id follows GitLab Workflow's makeAccountId, so a rename keeps the account. */
export interface AccountRecord {
  /** "<serverId>|<userId>" */
  readonly id: string;
  readonly serverId: string;
  readonly userId: string;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  readonly auth: ForgeSignInRoute;
  readonly scopes: readonly string[];
  readonly agentShells: boolean;
  readonly needsSignIn?: boolean;
  readonly needsSignInAt?: number;
  /** The OAuth app that issued the token: a refresh and a revoke reuse it. */
  readonly clientId?: string;
  readonly addedAt: number;
}

/** One account's secret; a rotation writes both tokens together. Never logged, never sent to a renderer. */
export interface TokenSet {
  readonly access: string;
  readonly refresh?: string;
  /** Epoch ms. */
  readonly accessExpiresAt?: number;
  readonly refreshExpiresAt?: number;
  readonly tokenType: 'oauth' | 'personal';
}

/** An OAuth client as a server uses it; the secret exists only for GitHub apps (build config or a GHES server's secret). */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
}

/** The OAuth apps the build carries (esbuild's __DAMOCLES_FORGE_OAUTH__ in the core-host bundle). */
export interface ForgeBuildOAuth {
  readonly github?: { readonly clientId: string; readonly clientSecret?: string };
  readonly gitlab?: { readonly clientId: string };
}

/** A built-in server pointed elsewhere: the DAMOCLES_E2E_FORGE_SERVERS hook of development builds. */
export interface ForgeServerOverride {
  readonly webUrl: string;
  readonly apiUrl?: string;
  readonly oauth?: { readonly clientId: string; readonly clientSecret?: string };
}

/** A server as core uses it: its record plus the URLs and the OAuth client it resolves to. */
export interface ForgeServer {
  readonly record: ServerRecord;
  readonly id: string;
  readonly kind: ForgeKind;
  readonly flavor: ForgeFlavor;
  readonly builtIn: boolean;
  /** https://host[:port][/path], no trailing slash. */
  readonly webUrl: string;
  /** The REST API base, no trailing slash. */
  readonly apiUrl: string;
  /** The origins a token for this server may go to: the web origin and the API origin. */
  readonly origins: ReadonlySet<string>;
  readonly oauth?: OAuthClient;
}

/** Why an HTTP call failed, as http.ts classifies it (docs/invariants.md "A token goes only to its own server's origins"). */
export type ForgeHttpErrorKind = 'unauthorized' | 'forbidden' | 'notFound' | 'rateLimited' | 'ssoRequired' | 'appNotApproved' | 'refused' | 'network' | 'tls' | 'server';

export class ForgeHttpError extends Error {
  readonly kind: ForgeHttpErrorKind;
  readonly status?: number;
  /** ssoRequired: the authorization URL GitHub named. */
  readonly ssoUrl?: string;
  /** rateLimited: epoch ms when a retry may go. */
  readonly retryAt?: number;
  /** refused: the server's own reason, raw and hostile; never logged and never part of `message`. */
  readonly serverText?: string;
  /** The host (with any port, at most 253 characters before it) that failed when it is not one of the server's origins, such as GitHub's log storage. */
  readonly foreignHost?: string;
  /** network: the SSRF guard refused foreignHost's address, which is private. */
  readonly privateAddress?: true;

  constructor(kind: ForgeHttpErrorKind, message: string, extra: { status?: number; ssoUrl?: string; retryAt?: number; serverText?: string; foreignHost?: string; privateAddress?: true; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = 'ForgeHttpError';
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.ssoUrl !== undefined) this.ssoUrl = extra.ssoUrl;
    if (extra.retryAt !== undefined) this.retryAt = extra.retryAt;
    if (extra.serverText !== undefined) this.serverText = extra.serverText;
    if (extra.foreignHost !== undefined) this.foreignHost = extra.foreignHost;
    if (extra.privateAddress) this.privateAddress = true;
  }
}

/** A sign-in that failed for a reason the user can act on; `text` is shown verbatim. */
export class ForgeSignInError extends Error {
  readonly kind: 'cancelled' | 'expired' | 'denied' | 'input' | 'network' | 'provider';
  readonly text: LocalizedText;

  constructor(kind: ForgeSignInError['kind'], text: LocalizedText) {
    super(text.message);
    this.name = 'ForgeSignInError';
    this.kind = kind;
    this.text = text;
  }
}
