import * as fs from 'node:fs';
import * as path from 'node:path';

const STUB = path.join(__dirname, '..', 'fixtures', 'prettier-stub', 'index.js');

/** Copies the stub `prettier` package into dir/node_modules/prettier, with the version that picks its API; delayMs slows format. */
export function installPrettierStub(dir: string, version: string, delayMs = 0): string {
  const packageDir = path.join(dir, 'node_modules', 'prettier');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.copyFileSync(STUB, path.join(packageDir, 'index.js'));
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'prettier', version, main: 'index.js', delayMs }));
  return packageDir;
}
