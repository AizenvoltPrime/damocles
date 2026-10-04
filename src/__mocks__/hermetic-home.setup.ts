// Must stay free of imports that reach `src/core/paths.ts`: its `DAMOCLES_HOME_DIR` reads `os.homedir()` at import.
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { inject } from "vitest";

// Removed with its root by `test-home.global-setup.ts`.
const home = mkdtempSync(join(inject("testHomeRoot"), "h-"));
// Windows resolves the LocalAppData and RoamingAppData known folders under %USERPROFILE%. With them
// missing, Chrome cannot resolve its default profile dir and refuses the DevTools pipe Playwright drives.
if (process.platform === "win32") {
  for (const dir of ["Local", "Roaming"]) mkdirSync(join(home, "AppData", dir), { recursive: true });
}
// `os.homedir()` reads USERPROFILE on Windows and HOME on POSIX. Only the forks pool honours
// this: in a worker thread, `process.env` writes do not reach `os.homedir()`.
process.env["USERPROFILE"] = home;
process.env["HOME"] = home;
// `os.tmpdir()` reads TEMP then TMP on Windows and TMPDIR then TMP then TEMP on POSIX. Under the run
// root, whatever a test leaves in its temp dir is removed by the global teardown.
const tmp = mkdtempSync(join(inject("testHomeRoot"), "t-"));
for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = tmp;
