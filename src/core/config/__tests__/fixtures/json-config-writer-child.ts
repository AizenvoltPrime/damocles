// Bundled by json-config-write.cross-process.test.ts and forked; argv: <file> <prefix> <count>.
import { writeJsonConfig } from '../../json-config-write';

const [file, prefix, countArg] = process.argv.slice(2);
if (file === undefined || prefix === undefined || countArg === undefined) {
  throw new Error('usage: json-config-writer-child <file> <prefix> <count>');
}
const count = Number(countArg);

async function run(file: string, prefix: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await writeJsonConfig(file, (current) => {
      const obj = current === undefined ? {} : (JSON.parse(current) as Record<string, number>);
      obj[`${prefix}-${i}`] = i;
      return JSON.stringify(obj, null, 2);
    });
  }
}

// The parent sends 'go' to every child at once so the writers interleave from the first write.
process.once('message', () => {
  run(file, prefix, count).then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
});
process.send!('ready');
