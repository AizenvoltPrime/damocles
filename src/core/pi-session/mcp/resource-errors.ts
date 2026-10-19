import type { McpResourceServer } from './tool-source';
import { stripBidiControls, stripControlChars } from '../untrusted-text';

/** A server name as resource errors list it: config text, flattened so it cannot forge a line. */
export function printableServerName(name: string): string {
  return stripBidiControls(stripControlChars(name));
}

/** A server name a call sent, quoted exactly (JSON escapes keep it on one line), so a stray space stays visible. */
export function quotedServerName(name: string): string {
  return JSON.stringify(stripBidiControls(name));
}

function serversWithResourcesText(servers: readonly McpResourceServer[]): string {
  return servers.length > 0
    ? `Servers with resources: ${servers.map((s) => printableServerName(s.serverName)).join(', ')}.`
    : 'No MCP server here offers resources.';
}

/** A resource request naming a server the source does not expose. */
export function unknownResourceServerError(name: string, servers: readonly McpResourceServer[]): Error {
  return new Error(`MCP server ${quotedServerName(name)} is not available here. ${serversWithResourcesText(servers)}`);
}

export function resourcesOffError(name: string): Error {
  return new Error(
    `The resources of MCP server ${quotedServerName(name)} are turned off. The user can turn them on with its Resources row in the MCP panel.`,
  );
}

export function noResourcesError(name: string, servers: readonly McpResourceServer[]): Error {
  return new Error(`MCP server ${quotedServerName(name)} offers no resources. ${serversWithResourcesText(servers)}`);
}

/** A resource request whose expected server identity is gone: removed, or the name now reaches another server. */
export class McpResourceServerGoneError extends Error {
  constructor(name: string) {
    super(`MCP server ${quotedServerName(name)} is no longer available`);
    this.name = 'McpResourceServerGoneError';
  }
}
