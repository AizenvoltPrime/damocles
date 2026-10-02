import type { McpServerErrorInfo } from '../../../shared/types/mcp';
import { flattenServerText } from './utils';

/**
 * A connect that failed for a reason the panel can name; `message` is the English fallback. It carries
 * no `cause`: `util.inspect` prints a cause even when it is not enumerable, and an HTTP cause holds a
 * response body.
 */
export class McpServerConnectError extends Error {
  readonly errorInfo: McpServerErrorInfo | undefined;
  /** The last `MCP_STDERR_TAIL_CHARS` of a stdio server's stderr, sanitized. Not enumerable, so `%O` never logs it. */
  declare readonly stderrTail: string | undefined;
  /** `failureForLog` of the error the connect failed on, decided while that error is still known; the message copies its server text. */
  readonly logText: string | undefined;

  constructor(message: string, options: { errorInfo?: McpServerErrorInfo; stderrTail?: string; logText?: string } = {}) {
    super(message);
    this.name = 'McpServerConnectError';
    this.errorInfo = options.errorInfo;
    Object.defineProperty(this, 'stderrTail', { value: options.stderrTail, enumerable: false });
    this.logText = options.logText;
  }
}

/**
 * A failure as one log line that holds no server output. pi-mcp puts response-body text in the message
 * of an HTTP error, a registration error and an OAuthError, and V8 quotes the start of the raw input in a
 * JSON.parse SyntaxError; those log fixed text. The panel keeps the full message.
 */
export function failureForLog(error: unknown): string {
  if (error instanceof McpServerConnectError && error.logText !== undefined) return error.logText;
  const status = httpErrorStatus(error);
  if (status !== undefined) return `${error instanceof Error ? error.name : 'Error'}: HTTP status ${status}`;
  if (error instanceof SyntaxError) return 'received a line that is not JSON';
  if (error instanceof Error && error.name === 'OAuthError' && 'code' in error && typeof error.code === 'string') {
    return `OAuth error ${flattenServerText(error.code, 64)}`;
  }
  return flattenServerText(error instanceof Error ? error.message : String(error));
}

/** The status of a pi-mcp `McpHttpError` or `OAuthRegistrationError` (`status` and `body`); their classes live in the dynamically loaded bundle. */
function httpErrorStatus(error: unknown): number | undefined {
  return error instanceof Error && 'body' in error && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}
