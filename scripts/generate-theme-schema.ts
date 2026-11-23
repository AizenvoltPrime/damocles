import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeSchema } from '../src/shared/themes/schema.ts';
import { isEntryPoint } from './entry-point.ts';

/**
 * The JSON Schema of a desktop theme file, for theme authors' editors and the store's checks (docs/themes.md).
 *
 *   node scripts/generate-theme-schema.ts          # write schemas/theme.schema.json
 *   node scripts/generate-theme-schema.ts --check  # exit 1 if the committed file is stale
 *
 * The source is the TypeBox schema in src/shared/themes/schema.ts; the code checks a schema cannot say (UUID ids, a look's
 * colors, asset references) are docs/themes.md's.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = join(ROOT, 'schemas', 'theme.schema.json');

export function renderThemeSchema(): string {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Damocles theme',
    description: 'A Damocles desktop theme file, theme.json (docs/themes.md).',
    ...(JSON.parse(JSON.stringify(themeSchema)) as object),
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function readCommitted(): string | undefined {
  try {
    return readFileSync(OUTPUT, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

function main(): void {
  const text = renderThemeSchema();
  const name = relative(ROOT, OUTPUT);
  const committed = readCommitted();
  // .gitattributes pins the file to LF, so a checkout holds these bytes on every platform.
  const upToDate = committed === text;
  if (process.argv.includes('--check')) {
    if (!upToDate) {
      console.error(`${name} is ${committed === undefined ? 'missing' : 'stale'}. Run: npm run generate:theme-schema`);
      process.exit(1);
    }
    console.log(`${name} is up to date.`);
    return;
  }
  if (upToDate) {
    console.log(`${name} is up to date.`);
    return;
  }
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, text);
  console.log(`Wrote ${name}`);
}

if (isEntryPoint(import.meta.url)) main();
