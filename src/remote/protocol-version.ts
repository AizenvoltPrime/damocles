// Attach is gated on PROTOCOL_VERSION alone, never the app version; a client and a daemon talk when theirs are equal.
// - The welcome advertises FEATURES. The app uses a contract a daemon of the same version may lack (a control command, an
//   attach option, resume) only when welcome.features lists its name, else treats it as unsupported; the daemon checks no
//   name, since hello carries no feature list.
// - Outside the frozen set, a change is additive (a new command, channel, event or optional field) and named in FEATURES, or
//   it increments the number: removing or changing a command, a field or its meaning, or adding a value to a closed list the
//   older side parses strictly. While PROTOCOL_PRE_RELEASE is true no older peer exists, so a breaking change is named in
//   FEATURES and needs no bump; once it is false, every breaking change bumps.
// - Frozen across every version: the mutual authentication's three messages, PersistentProtocol framing, the mux frame format,
//   the codec, the handshake messages, `refused` with its two reasons, and the control commands of FrozenControl
//   (control-messages.ts), which stay open after `refused { reason: 'protocol' }`.
// scripts/protocol-compat.mjs enforces these rules against the committed protocol-snapshot.json and, in CI, the base branch's.
export const PROTOCOL_VERSION = 1;

// True until the first release that ships remote features: no older peer exists, so `protocol-compat.mjs --allow-breaking`
// may regenerate the snapshot over a breaking change without a bump. Never set back to true once false.
export const PROTOCOL_PRE_RELEASE: boolean = true;

export const FEATURES: readonly string[] = ['core.attach', 'control.coreState', 'control.restartCore', 'views.join', 'settingsView.scope', 'user.credentials', 'user.voice.speak', 'client.mirrors', 'chat.remotePolicy', 'editor.markdownContent', 'client.sharedLoopback', 'workspace.hostSettings', 'client.allowance', 'account.allowanceUnavailable', 'account.modelPicker', 'account.providerPrecedence', 'account.providerSignIn', 'client.availableModelIds', 'client.keySaved', 'client.preferApiKey', 'chat.modelRefusal', 'account.authFailureReason', 'history.authFailureReplay', 'account.authFailureMissing', 'chat.modelRefusalAccount', 'chat.promptRejected', 'chat.btwAuthFailure', 'chats.openTranscript', 'model.credentialSource', 'chats.listMirrored', 'protocol.resume', 'control.ping', 'views.drained', 'actor', 'panelViews', 'credentialsPush', 'signIn', 'clients', 'linger', 'chats.stop', 'control.disconnect', 'chat.activity.sessionId', 'askpass.credential', 'askpass.daemonRelay', 'agent.forwarding', 'ssh.installAuthorizedKey', 'control.shutdownForRemoval', 'settings.remoteHosts', 'capabilities.bypassPermissions', 'credentialsPush.planModelIds', 'terminals.view', 'terminals.detachView', 'files.watchLimit', 'control.sharedHome', 'agent.perClientSockets', 'hostSockets', 'linger.alreadyEnabled', 'linger.domainUsers', 'ssh.installAuthorizedKey.accountFailed', 'ssh.installAuthorizedKey.restricted', 'askpass.credential.verifiedErase', 'e2e.stubOAuth', 'usageStats.byCredential', 'panels.viewDetached', 'panels.binaryAudience', 'chat.queuedPartsReturn', 'control.listOwnRuns', 'files.watchReady'];
