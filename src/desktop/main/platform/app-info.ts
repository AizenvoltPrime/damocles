import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import type { AppInfo } from '../../../platform/app-info';
import type { DesktopLayout } from './app-paths';

// Launched as `electron dist/desktop/main.js`, app.getVersion() reports Electron's version, so the unpackaged layout reads the repo package.json.
export function createDesktopAppInfo(layout: DesktopLayout): AppInfo {
  if (layout.packaged) return { version: app.getVersion() };
  const manifestPath = path.join(layout.repoRoot, 'package.json');
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = (manifest as { version?: unknown } | null)?.version;
  if (typeof version !== 'string' || version === '') throw new Error(`No version in ${manifestPath}`);
  return { version };
}
