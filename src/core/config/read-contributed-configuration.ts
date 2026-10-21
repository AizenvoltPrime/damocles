import * as path from 'node:path';
import { readFileSync } from '../resource-fs';
import { parseContributedConfiguration, type ContributedConfiguration, type Manifest } from './contributed-configuration';

const cache = new Map<string, ContributedConfiguration>();

/** The settings package.json under resourceRoot contributes; read once per root. */
export function readContributedConfiguration(resourceRoot: string): ContributedConfiguration {
  const cached = cache.get(resourceRoot);
  if (cached) return cached;
  const manifest = JSON.parse(readFileSync(path.join(resourceRoot, 'package.json'), 'utf8')) as Manifest;
  const parsed = parseContributedConfiguration(manifest);
  cache.set(resourceRoot, parsed);
  return parsed;
}
