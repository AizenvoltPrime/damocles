import { installProcessLauncher } from '../core/process-launcher';
import { createInProcessLauncher } from '../core/process-launcher/in-process';
import { createWalkHost, installWalkHost } from '../core/search-walk/walk-host';
import { installFakePlatform } from './fake-platform';
import { InThreadWalkChild } from './in-thread-walk-child';

// The host installs its platform before any core code runs; tests needing specific values reinstall in beforeEach.
installFakePlatform();
// Starts run on the test's own thread, so a test's vi.mock of child_process still sees them.
installProcessLauncher(createInProcessLauncher());
// Core's walks run on this thread, so a test's fs spies see them; a test of the walk process itself starts the built one.
installWalkHost(createWalkHost(() => new InThreadWalkChild(), () => undefined));
