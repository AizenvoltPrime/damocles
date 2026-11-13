import type { ForgeKind } from "./accounts";

// Wire and renderer types of project bindings, resolution and host defaults (docs/invariants.md "GitHub and GitLab accounts").
// Nothing here carries a token or a remote URL's password; a login and a host are data, never translated.

/** How a server's account was settled for a project, in the resolution order. */
export type ResolveHow = "bound" | "hostDefault" | "onlyAccount" | "usernameHint" | "access" | "choice";

export const RESOLVE_HOWS: readonly ResolveHow[] = ["bound", "hostDefault", "onlyAccount", "usernameHint", "access", "choice"];

/** How a target's credential request may be answered with no consent dialog: the user chose the account. */
export const CONSENTED_HOWS: ReadonlySet<ResolveHow> = new Set<ResolveHow>(["bound", "hostDefault", "choice"]);

/** Where one URL of a remote points, as git and ssh -G name it on the repository's own host. */
export interface RemoteLocation {
  readonly protocol: "https" | "ssh";
  /** Lowercase host name; after ssh -G its HostName. */
  readonly host: string;
  /** Absent for the scheme's default port. */
  readonly port?: number;
  /** The URL's path without leading or trailing slashes, `.git` kept as written: "grp/sub/proj.git". */
  readonly path: string;
  /** A user name from the URL's userinfo or git's credential.username, placeholders (oauth2, git, token, ...) left out. */
  readonly usernameHint?: string;
  /** ssh -G answered for this host, which may be an alias. */
  readonly aliasResolved: boolean;
}

/** One remote of a repository: its fetch URL and, when it differs, its push URL. */
export interface RemoteEndpoint {
  readonly remote: string;
  readonly fetch?: RemoteLocation;
  /** Absent: pushes go to fetch. */
  readonly push?: RemoteLocation;
}

/** An account as the chip menu, the Choose account dialog and the host defaults list show it. */
export interface RepoAccountOption {
  /** "<serverId>|<userId>" */
  readonly id: string;
  readonly login: string;
  readonly name?: string;
  /** app://damocles/forge/avatar/<avatarKey>; absent: the initial. */
  readonly avatarKey?: string;
  readonly needsSignIn: boolean;
  /** The access check is still running for this account. */
  readonly checking?: boolean;
  /** From the access check: absent while unknown (not checked, checking, or the check could not reach the server). */
  readonly canPush?: boolean;
  /** GitLab access level 50, GitHub admin: the Choose account dialog's "owner" (GitLab) or "admin" (GitHub) chip. */
  readonly owner?: boolean;
  /** GitHub: the organization requires SAML SSO authorization for this token. */
  readonly ssoRequired?: boolean;
  /** GitHub: the organization has not approved Damocles' OAuth app. */
  readonly appNotApproved?: boolean;
}

interface RepoServerFacts {
  readonly serverId: string;
  /** The server's id as shown, such as gitlab.indigital.gr. */
  readonly server: string;
  readonly kind: ForgeKind;
  /** The repository's remotes on this server. */
  readonly remotes: readonly string[];
  /** The push remote's server: the current branch's upstream remote, else origin. At most one server has it. */
  readonly isPush: boolean;
  /** The repository's path on the server, such as grp/sub/proj, for the Choose account dialog's where-line. */
  readonly repoPath: string;
  /** This server's accounts, for the menu's radio items. */
  readonly accounts: readonly RepoAccountOption[];
  /** The access check could not reach the server: the account chip's notice line, whose Try again asks with recheck. */
  readonly checkFailed?: boolean;
}

/** A server whose account resolved or is bound: the account and how it was settled. */
interface RepoServerSettled extends RepoServerFacts {
  readonly state: "auto" | "chosen" | "signInAgain";
  readonly how: ResolveHow;
  readonly account: RepoAccountOption;
}

/** A server with no account to use: nothing resolved, Git's own credentials, or no account on this computer. */
interface RepoServerUnsettled extends RepoServerFacts {
  readonly state: "choose" | "ownCredentials" | "signIn";
}

/**
 * auto: chosen automatically (how is hostDefault excluded); chosen: bound by the user, or the host default; choose: nothing
 * resolved; signInAgain: the resolved account must sign in again; ownCredentials: bound to "Use Git's own credentials";
 * signIn: the server has no account on this computer.
 */
export type RepoServerAccounts = RepoServerSettled | RepoServerUnsettled;

/** The account chip's data; servers is empty when no remote is on a server Damocles knows, which shows no chip. */
export interface RepoAccountsView {
  readonly projectKey: string;
  /** The project's name as the project list shows it. */
  readonly project: string;
  /** The push server first, then by server id. */
  readonly servers: readonly RepoServerAccounts[];
}

export interface HostDefaultServer {
  readonly serverId: string;
  readonly server: string;
  readonly kind: ForgeKind;
  /** The server's git hosts, which the consent row ("as <login>, the default") matches its credential hosts against. */
  readonly gitHosts: readonly string[];
  readonly accounts: readonly { readonly id: string; readonly login: string; readonly avatarKey?: string }[];
  readonly defaultAccountId?: string;
}

/** Default accounts on a host: loading until core has read its forge files; error when they could not be read; ready lists servers with an account. */
export type HostDefaultsView =
  | { readonly state: "loading" }
  | { readonly state: "error" }
  | { readonly state: "ready"; readonly servers: readonly HostDefaultServer[] };

/** The git operations that may ask once. */
export type ForgeGitOperation = "push" | "pull" | "fetch" | "clone" | "publish";

export const FORGE_GIT_OPERATIONS: readonly ForgeGitOperation[] = ["push", "pull", "fetch", "clone", "publish"];

/** The answer to the Choose account dialog: an account, Git's own credentials (null), a cancel, or "Sign in with another account…". */
export type ChooseAccountAnswer =
  | { readonly kind: "account"; readonly accountId: string | null }
  | { readonly kind: "cancelled" }
  | { readonly kind: "signInAnother" };

/** The Choose account dialog's rows while the access check runs; the request opens with the first set. */
export interface ChooseAccountRows {
  readonly requestId: string;
  readonly accounts: readonly RepoAccountOption[];
  readonly checking: boolean;
  /** The best match, preselected with its owner chip. */
  readonly preselectId?: string;
}

/** What core asks main to show (CoreRequest forge.chooseAccount). */
export interface ChooseAccountRequest extends ChooseAccountRows {
  /** Absent for a clone, whose project does not exist yet. */
  readonly projectKey?: string;
  readonly project: string;
  readonly serverId: string;
  readonly server: string;
  readonly kind: ForgeKind;
  /** The repository's path on the server; with server it makes the where-line's target. */
  readonly repoPath: string;
  readonly operation: ForgeGitOperation;
}
