import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { expect, it } from 'vitest';
import { themeValidatorOptions } from '../../esbuild.config.ts';

const ROOT = join(__dirname, '..', '..');

// The community store's CI is the only other place that builds these, so a break would show there first.
it('bundles the theme validator\'s launcher and its Electron host', async () => {
  expect(themeValidatorOptions.map((options) => options.outfile)).toEqual(['dist/theme-validate.js', 'dist/theme-validate/host.js']);
  for (const options of themeValidatorOptions) {
    const result = await esbuild.build({ ...options, absWorkingDir: ROOT, write: false, logLevel: 'silent' });
    expect(result.errors, options.outfile).toEqual([]);
    expect(result.outputFiles.map((file) => file.path.replaceAll('\\', '/')), options.outfile).toEqual([join(ROOT, options.outfile!).replaceAll('\\', '/')]);
    expect(result.outputFiles[0]!.text.length, options.outfile).toBeGreaterThan(0);
  }
}, 120_000);
