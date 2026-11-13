import { l } from '../../l10n';
import type { ForgeHttp } from '../http';
import type { ForgeProvider, ForgeUser, TokenGrant } from '../providers/provider';
import { ForgeSignInError, type ForgeServer } from '../types';

// The personal access token route, after VS Code's github-authentication flows.ts 525 (MIT) and GitLab Workflow's
// pat_flow.ts (MIT): GitHub checks GET /user and X-OAuth-Scopes, GitLab /personal_access_tokens/self, /user and /version.

const MAX_TOKEN_CHARS = 1024;
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

export async function signInWithToken(http: ForgeHttp, server: ForgeServer, provider: ForgeProvider, pasted: string): Promise<{ readonly user: ForgeUser; readonly grant: TokenGrant; readonly version?: string }> {
  const token = pasted.trim();
  if (token === '') throw new ForgeSignInError('input', l('Paste a token first.'));
  if (token.length > MAX_TOKEN_CHARS || !TOKEN_CHARS.test(token)) throw new ForgeSignInError('input', l('That is not a token. Paste the whole token, with nothing before or after it.'));
  const { user, scopes, version } = await provider.validateToken(http, server, token);
  return { user, grant: { tokens: { access: token, tokenType: 'personal' }, scopes }, ...(version !== undefined ? { version } : {}) };
}
