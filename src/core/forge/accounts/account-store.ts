// makeAccountId adapted from GitLab Workflow for VS Code (https://gitlab.com/gitlab-org/gitlab-vscode-extension),
// src/common/platform/gitlab_account.ts. Copyright (c) 2020-present GitLab Inc. Licensed under the MIT License (THIRD-PARTY-NOTICES.md).
import * as path from 'node:path';
import { FORGE_SIGN_IN_ROUTES } from '../../../shared/forge/accounts';
import { createForgeFile, type ForgeFile } from '../forge-file';
import type { AccountRecord, ForgeSignInRoute } from '../types';

// accounts.json: { version: 1, accounts: AccountRecord[] }. No secret is ever in it.

export interface AccountsFile {
  readonly version: 1;
  readonly accounts: readonly AccountRecord[];
}

/** The longest text field, scope included, a record may hold. */
export const MAX_ACCOUNT_TEXT = 1024;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ACCOUNT_TEXT;
}

function optionalText(record: Record<string, unknown>, key: string): Record<string, string> {
  return text(record[key]) ? { [key]: record[key] as string } : {};
}

function parseAccount(raw: unknown): AccountRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const { id, serverId, userId, login, auth, scopes, agentShells, addedAt } = record;
  if (!text(id) || !text(serverId) || !text(userId) || !text(login) || id !== `${serverId}|${userId}`) return undefined;
  if (typeof auth !== 'string' || !(FORGE_SIGN_IN_ROUTES as readonly string[]).includes(auth)) return undefined;
  if (!Array.isArray(scopes) || !scopes.every(text) || typeof agentShells !== 'boolean' || typeof addedAt !== 'number') return undefined;
  return {
    id,
    serverId,
    userId,
    login,
    ...optionalText(record, 'name'),
    ...optionalText(record, 'avatarUrl'),
    ...optionalText(record, 'clientId'),
    auth: auth as ForgeSignInRoute,
    scopes: scopes as string[],
    agentShells,
    ...(record['needsSignIn'] === true ? { needsSignIn: true } : {}),
    ...(typeof record['needsSignInAt'] === 'number' ? { needsSignInAt: record['needsSignInAt'] } : {}),
    addedAt,
  };
}

export function parseAccountsFile(raw: unknown): AccountsFile | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { version, accounts } = raw as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(accounts)) return undefined;
  const parsed = accounts.map(parseAccount);
  return parsed.every((account): account is AccountRecord => account !== undefined) ? { version: 1, accounts: parsed } : undefined;
}

export function createAccountStore(forgeDir: string, log: (line: string) => void): ForgeFile<AccountsFile> {
  return createForgeFile({ filePath: path.join(forgeDir, 'accounts.json'), parse: parseAccountsFile, empty: { version: 1, accounts: [] }, log });
}

export function makeAccountId(serverId: string, userId: string): string {
  return `${serverId}|${userId}`;
}
