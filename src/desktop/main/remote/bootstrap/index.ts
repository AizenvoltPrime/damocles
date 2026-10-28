// The bootstrap's facade: what main needs beside the SSH transport.
export { PROBE_FAILURES, PROBE_NOTICES, type ProbeFailureCode, type ProbeNoticeCode } from './probe-parse';
export { validateInstallFolder, type InstallFolderCheck } from './stage1';
