// A host id the desktop host store draws (9 random bytes in base64url): one path segment, never `.` or `..`.
const HOST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isHostId(value: string): boolean {
  return HOST_ID.test(value);
}
