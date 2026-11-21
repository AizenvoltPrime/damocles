// withinProject: the realpath must lie under the folder's; throughLinks: or under the realpath of the deepest link the path
// crosses (docs/invariants.md "Desktop host", Confinement). Every caller states one.
export type LinkRule = 'withinProject' | 'throughLinks';

// link: the '/'-separated path of the deepest link the path crosses, a file for a file link; realRoot: that link's native realpath
export interface LinkRoot {
  readonly link: string;
  readonly realRoot: string;
}

// A host's refusal of a path a link on it leads off, as the host and the wire carry it: share, a link onto a UNC, WSL or
// device path, never followed.
export type HostLinkRefusal = 'share';

// A client's: oldDaemon, a host that cannot follow links out of its projects; no host and no wire answer carries it.
export type LinkRefusal = HostLinkRefusal | 'oldDaemon';

// via: set only under throughLinks, when the realpath leaves the folder's
export type ConfinedFile = { readonly ok: true; readonly path: string; readonly via?: LinkRoot } | { readonly ok: false; readonly reason: 'outside' | 'missing' | 'failed' };

/** The host's rule for a file a renderer names inside a folder; core resolves such a file only through it. */
export interface FileConfinement {
  // relativePath: '/' separated. ok: the file's real path, which lies under the folder's real path, or under via.realRoot.
  confineExisting(folder: string, relativePath: string, rule: LinkRule): Promise<ConfinedFile>;
}
