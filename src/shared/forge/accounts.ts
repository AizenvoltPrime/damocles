import type { LocalizedText } from '../localized-text';
import type { ProviderSignInError } from '../types/settings';

// Wire and renderer types of Settings › Models & accounts › Git hosting (docs/invariants.md "GitHub and GitLab accounts").
// No type here ever carries a token, refresh token, client secret, OAuth code or PKCE verifier.

export type ForgeKind = "github" | "gitlab";
export type ForgeFlavor = "github.com" | "ghe.com" | "ghes" | "gitlab";
export type ForgeSignInRoute = "browser" | "device" | "token";

/** The largest account picture core fetches and main serves. */
export const FORGE_AVATAR_MAX_BYTES: number = 512 * 1024;

export const FORGE_SIGN_IN_ROUTES: readonly ForgeSignInRoute[] = ["browser", "device", "token"];

/** Core answers a longer value with a field refusal; the settings view binds each as its field's maxlength. */
export const MAX_FORGE_TOKEN_CHARS: number = 8 * 1024;
export const MAX_FORGE_FIELD_CHARS = 2048;
export const MAX_FORGE_GIT_HOSTS = 64;
export const MAX_FORGE_GIT_HOST_CHARS = 260;

/** A route the server row offers: available without a reason; a reason is the hint shown on the disabled SettingSeg option. */
export interface ForgeRouteAvailability { reason?: LocalizedText }

/** Each sign-in route's availability; spelled out, not a Record, so the localized-text contract test sees each reason. */
export interface ForgeRoutes {
  browser: ForgeRouteAvailability;
  device: ForgeRouteAvailability;
  token: ForgeRouteAvailability;
}

export interface ForgeServerSummary {
  /** Stable server id; "github.com" and "gitlab.com" for the built-ins. */
  id: string;
  kind: ForgeKind;
  flavor: ForgeFlavor;
  /** Web host shown in the row and in "Add account: <server>". */
  host: string;
  /** https://host[/path] */
  baseUrl: string;
  builtIn: boolean;
  /** Self-managed GitLab and GHES only; drives the version badge. */
  version?: string;
  /** The hosts git reaches this server by; Damocles answers git's credential requests for them. */
  gitHosts: string[];
  /**
   * Hosts learned from the server's clone URLs that wait for the user: none is managed, matched to a remote or answered
   * with credentials until forgeConfirmGitHost moves it into gitHosts. Shown in the Edit server form.
   */
  pendingGitHosts: string[];
  /** Added servers only; built-ins never expose build-config ids here. */
  oauthClientId?: string;
  /** GHES; the secret itself never leaves core. */
  hasClientSecret: boolean;
  /** Shown in the server form's code box with Copy. */
  redirectUri?: string;
  routes: ForgeRoutes;
  /** Scope chips for the Token route. */
  tokenScopes: string[];
}

/** GitHub organization access problems found for an account (docs/invariants.md "GitHub organization access"). */
export interface ForgeOrgAccessIssue { kind: "ssoRequired" | "appNotApproved"; org: string }

export interface ForgeAccountSummary {
  /** "<serverId>|<userId>" */
  id: string;
  serverId: string;
  login: string;
  name?: string;
  /** The renderer loads app://damocles/forge/avatar/<avatarKey>; absent: show the initial. */
  avatarKey?: string;
  route: ForgeSignInRoute;
  scopes: string[];
  /** The "Agent shells may use this account" switch. */
  agentShells: boolean;
  /** Refused or expired: Manage shows the warning and "Sign in again" / "Enter a new token". */
  needsSignIn: boolean;
  /** Epoch ms when core found the token refused or expired; present only with needsSignIn. */
  needsSignInAt?: number;
  /** Epoch ms, the sign-in date. */
  addedAt: number;
  /** For the sign-out confirmation text: the projects bound to the account and the remote hosts whose default it is. */
  bindings: { projects: number; hosts: number };
  orgAccess: ForgeOrgAccessIssue[];
}

export interface ForgeNotice {
  id: string;
  kind: "revokeFailed";
  /** Names the login and server, says the token must be revoked by hand. */
  message: LocalizedText;
}

export interface ForgeAccountsState {
  status: "loading" | "ready" | "error";
  /**
   * loadFailed: a forge file could not be read, nothing changes until a restart. brokenFile: a forge file does not parse,
   * and the banner offers "Show file".
   */
  error?: { kind: "loadFailed" | "brokenFile"; message: LocalizedText };
  /** Built-ins first, then added servers in addedAt order. */
  servers: ForgeServerSummary[];
  accounts: ForgeAccountSummary[];
  notices: ForgeNotice[];
  /** The redirect URI a new server of each kind would register, for the Add server form. */
  redirectUris: Record<ForgeKind, string>;
  /** damocles.desktop.forge.showAvatars; false shows the initial instead of the avatar. */
  showAvatars: boolean;
}

/** ProviderSignInError and its kinds are reused unchanged (classes from sign-in-failure.ts). */
export type ForgeSignInState =
  /** A token refusal is kind "input" with the exact refusal text. */
  | { phase: "idle"; error?: ProviderSignInError }
  | { phase: "starting" }
  /** Waiting for the loopback callback. */
  | { phase: "browser" }
  | { phase: "deviceCode"; userCode: string; verificationUri: string; expiresAt: number }
  | { phase: "finishing" }
  /** The UI announces "Signed in as <login>". */
  | { phase: "signedIn"; accountId: string; login: string };

export type ForgeServerFormField = "url" | "kind" | "clientId" | "clientSecret" | "gitHosts";

/**
 * The settings view's answer to a pending git host of serverId (ForgeServerSummary.pendingGitHosts). Core answers with
 * forgeServerFormResult under the same requestId, a refusal on field "gitHosts", and publishes the new state.
 * Confirm: the host joins gitHosts unless another server claims it (a built-in host included) or the server has the most
 * git hosts it may have. Dismiss: the host leaves the pending list, and core remembers it so the same clone URLs never
 * propose it again.
 */
export interface ForgeConfirmGitHostRequest { type: "forgeConfirmGitHost"; requestId: string; serverId: string; host: string }
export interface ForgeDismissGitHostRequest { type: "forgeDismissGitHost"; requestId: string; serverId: string; host: string }
