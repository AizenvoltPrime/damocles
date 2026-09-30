import { installFakePlatform } from './fake-platform';

// The host installs its platform before any core code runs; tests needing specific values reinstall in beforeEach.
installFakePlatform();
