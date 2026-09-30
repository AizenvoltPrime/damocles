import { randomBytes } from 'crypto';
import * as fs from 'fs';

/** Replace `file` through a synced sibling temp file and a rename, so a crash leaves the old or the new content, never a torn one. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const handle = await fs.promises.open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

/** `writeFileAtomic` unless `file` already holds exactly `content`; returns whether it wrote. */
export async function writeFileAtomicIfChanged(file: string, content: string): Promise<boolean> {
  try {
    if ((await fs.promises.readFile(file, 'utf8')) === content) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await writeFileAtomic(file, content);
  return true;
}
