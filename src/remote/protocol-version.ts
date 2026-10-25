// Attach is gated on PROTOCOL_VERSION alone, never the app version; a client and a daemon talk when theirs are equal.
// - An additive change (a new command, channel, event or optional field) keeps the number and is named in FEATURES; each side
//   calls a newer command only when the other side lists it.
// - Removing or changing a command, a field or its meaning, or adding a value to a closed enum the older side parses strictly,
//   increments the number.
// - Frozen across every version: the mutual authentication's three messages, PersistentProtocol framing, the mux frame format,
//   the codec, the handshake messages, `refused` with its two reasons, and the control commands of FrozenControl
//   (control-messages.ts), which stay open after `refused { reason: 'protocol' }`.
// scripts/protocol-compat.mjs enforces these rules against the committed protocol-snapshot.json and, in CI, the base branch's.
export const PROTOCOL_VERSION = 1;

// True until the first release that ships remote features: no older peer exists, so `protocol-compat.mjs --allow-breaking`
// may regenerate the snapshot over a breaking change without a bump. Never set back to true once false.
export const PROTOCOL_PRE_RELEASE: boolean = true;

export const FEATURES: readonly string[] = ['core.attach', 'control.coreState', 'control.restartCore', 'views.join', 'settingsView.scope', 'user.credentials', 'user.voice.speak', 'client.mirrors', 'chat.remotePolicy', 'editor.markdownContent', 'client.sharedLoopback', 'workspace.hostSettings', 'client.allowance', 'account.allowanceUnavailable', 'account.modelPicker', 'account.providerPrecedence', 'account.providerSignIn', 'client.availableModelIds', 'client.keySaved'];
