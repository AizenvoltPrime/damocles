// Attach is gated on PROTOCOL_VERSION alone, never the app version; a client and a daemon talk when theirs are equal.
// - FEATURES names capabilities, each one a peer checks before using it: the welcome carries the daemon's, an app's
//   control.attachCore its own. A side sends what the peer may lack (a request, event, mirror topic or table entry an older
//   peer refuses or never answers, a tagged union's variant or a closed list's value its parser refuses) only when the peer
//   lists its name, since an endpoint closes the connection on a name outside its contract. The daemon checks a client's
//   names on the core channel (core-routes.ts `needs` and its sessionFile route) and, through the connection's latest attach,
//   on the workspace channel (workspace-host.ts), where a client not yet attached lists none. An added optional field needs no
//   name: the object parser drops a key outside its shape. A name no code checks does not belong here.
// - A breaking change increments the number: removing or changing a command, a field, a variant, a value or its meaning,
//   adding a required field, or adding a variant or value its sender cannot gate. While PROTOCOL_PRE_RELEASE is true no older
//   peer exists, so a breaking change needs no bump; once it is false, every breaking change bumps.
// - Frozen across every version: the mutual authentication's three messages, PersistentProtocol framing, the mux frame format,
//   the codec, the handshake messages, `refused` with its two reasons, and the control commands of FrozenControl
//   (control-messages.ts), which stay open after `refused { reason: 'protocol' }`.
// scripts/protocol-compat.ts enforces these rules against the committed protocol-snapshot.json and, in CI, the base branch's,
// and refuses a FEATURES list past MAX_FEATURES (handshake.ts), which both parsers refuse, or one that names a name twice.
export const PROTOCOL_VERSION = 1;

// True until the first release that ships remote features: no older peer exists, so `protocol-compat.ts --allow-breaking`
// may regenerate the snapshot over a breaking change without a bump. Never set back to true once false.
export const PROTOCOL_PRE_RELEASE: boolean = true;

export const FEATURES: readonly string[] = ['protocol.resume', 'control.ping', 'clients', 'linger', 'control.disconnect', 'ssh.installAuthorizedKey', 'control.shutdownForRemoval', 'files.watchLimit', 'control.sharedHome', 'askpass.credential.verifiedErase', 'control.listOwnRuns', 'files.watchReady', 'ports', 'clientMcp', 'mirror.changed', 'mirror.subcalls', 'control.portProbe', 'containers', 'agent.relay', 'files.transfer', 'files.makeLinkWithin', 'user.memory.heldQueues', 'files.verifyLink', 'files.folderMode', 'tools.setOnHost', 'files.outside', 'files.listOutside', 'sessionFiles', 'files.readOutsideLimit', 'design.read', 'design.info', 'design.openPreview', 'design.changed', 'design.capture', 'design.render', 'design.probe', 'design.journey', 'design.journeyScroll', 'design.replayJourney', 'design.markup', 'design.tweak', 'design.previewScreen', 'user.memory.list', 'files.readFileRange.resolvedPath', 'chats.showSession', 'user.browser.servedFiles', 'user.credentials.env', 'scm.remoteEndpoints', 'askpass.credential.origin', 'clientForges', 'user.forge', 'scm.commitOnRemote', 'scm.renameRemote', 'scm.commit.protectedBranches', 'scm.push.createOnly', 'scm.unpushedCount', 'scm.ignoreCase', 'client.pending', 'chat.configuredProviders', 'projects.relocate', 'mirror.worktreeChats', 'projects.relocationAbandon', 'design.infoMissing', 'user.browser.servedFolders', 'control.shutdownWhenIdle.clients', 'quickOpen.walk', 'search.walk', 'scm.absentProject', 'editor.isDirty', 'files.links', 'files.sessionFileRefusal', 'themes'];
