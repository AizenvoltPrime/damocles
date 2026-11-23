// node dist/theme-validate.js <file.damocles-theme> --thumbs <dir>
// Prints one JSON verdict on stdout: { ok, sha256, bytes, entry } or { ok: false, sha256, bytes, errors } (a file past the
// archive's size cap is refused unread, so its verdict has bytes and no sha256), and writes each thumbnail as
// <dir>/<sha256>.webp. Exit 0 accepted, 1 refused, 2 a usage or internal error (on stderr).
import * as path from 'node:path';
import { launch } from './launcher';

void launch(process.argv.slice(2), path.join(__dirname, 'theme-validate', 'host.js')).then((code) => {
  process.exitCode = code;
});
