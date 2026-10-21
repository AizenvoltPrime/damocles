import { installProcessLauncher } from '../core/process-launcher';
import { createInProcessLauncher } from '../core/process-launcher/in-process';
import { installFakePlatform } from './fake-platform';

// The host installs its platform before any core code runs; tests needing specific values reinstall in beforeEach.
installFakePlatform();
// Starts run on the test's own thread, so a test's vi.mock of child_process still sees them.
installProcessLauncher(createInProcessLauncher());
