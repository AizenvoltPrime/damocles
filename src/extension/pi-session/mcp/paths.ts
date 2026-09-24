import * as path from 'path';
import { DAMOCLES_HOME_DIR } from '../../paths';

/** Root for all MCP client state (caches, OAuth tokens), Damocles-owned. */
export const MCP_HOME_DIR: string = path.join(DAMOCLES_HOME_DIR, 'mcp');

/** Per-server tool/resource metadata cache (one JSON file per server, keyed by name hash). */
export const MCP_METADATA_CACHE_DIR: string = path.join(MCP_HOME_DIR, 'metadata-cache');

/** Pre-keychain OAuth token store (`sha256-<name hash>/tokens.json`), read only to migrate it into SecretStorage. */
export const MCP_OAUTH_DIR: string = path.join(MCP_HOME_DIR, 'oauth');

/** npx/npm-exec binary resolution cache. */
export const MCP_NPX_CACHE_PATH: string = path.join(MCP_HOME_DIR, 'npx-cache.json');
