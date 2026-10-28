// The SSH transport's facade: code outside ssh/ imports through it, and it exports only what that code uses.
export { isSafeAlias } from './ssh-args';
export { controlMasterPlan, exitControlMaster, runSsh, systemControlMasterDeps, type ControlMasterDeps, type ControlMasterPlan } from './control-master';
export { HostNotConnectedError, keyFolder, setUpPasswordless, type KeySetupDeps } from './key-setup';
export { createMainAskpassServer } from './ssh-askpass';
export { createRememberedSecrets, type RememberedSecrets } from './remembered-secrets';
export { checkSavedAddress, parseSshCommand, type SshDestination, type SshParseResult } from './ssh-command-parse';
export { configuredAliases, sshEnvironment } from './ssh-environment';
export { knownHostsRemoveCommand } from './ssh-stderr';
export { runSshStage, SshConnectError, sshVersion, startSshTransport, type RememberedOption, type SshAttemptHooks } from './ssh-transport';
