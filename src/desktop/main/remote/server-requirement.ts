// The release's server requirement (docs/release.md "Server packages"): a server below minimumServerVersion must switch within
// graceHours, and every host's security floor rises to the minimum. No imports, so a script loads it with Node's type stripping.
export const SERVER_REQUIREMENT: { minimumServerVersion: string; graceHours: number } | null = null;
