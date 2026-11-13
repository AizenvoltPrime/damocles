// The GitHub and GitLab stand-in and the log scan the forge specs share with the engine's unit tests.
export { FORGE_FIXTURES, startForgeStub, type ForgeStub, type ForgeStubOptions, type StubCreated, type StubLogStorage, type StubServer } from '../../../src/core/forge/__tests__/support/forge-stub';
export { CI_FIXTURES, CI_UI_FIXTURES, CiUi, LOG_TICK_MS, PLANTED_LOG_TOKEN, UNIT_LOG_LINES } from '../../../src/core/forge/__tests__/support/forge-stub-ci';
export { HISTORY_FIXTURES, HistoryUi, OVERSIZED_PICTURE_BYTES, stubPictureUrl, type StubChange, type StubPictures } from '../../../src/core/forge/__tests__/support/forge-stub-history';
export { scanLogFolder, secretsIn } from '../../../src/core/forge/__tests__/support/log-scan';
