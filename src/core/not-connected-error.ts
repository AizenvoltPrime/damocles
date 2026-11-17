/** An authority the host holds no connection to; the message is localized and names the host. */
export class NotConnectedError extends Error {
  override readonly name = 'NotConnectedError';
}
