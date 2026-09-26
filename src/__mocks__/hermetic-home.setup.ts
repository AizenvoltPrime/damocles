// Must stay free of imports that reach `src/extension/paths.ts`: its `DAMOCLES_HOME_DIR` reads `os.homedir()` at import.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { inject } from "vitest";

// Removed with its root by `test-home.global-setup.ts`.
const home = mkdtempSync(join(inject("testHomeRoot"), "home-"));
// `os.homedir()` reads USERPROFILE on Windows and HOME on POSIX. Only the forks pool honours
// this: in a worker thread, `process.env` writes do not reach `os.homedir()`.
process.env["USERPROFILE"] = home;
process.env["HOME"] = home;
