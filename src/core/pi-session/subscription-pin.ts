// The subscription plugin this computer installs and a server package bundles (scripts/subscription-plugin.mjs). A bump
// changes SUBSCRIPTION_COMMIT and SUBSCRIPTION_PLUGIN_SHA256 together; the build refuses the old hash and prints the new one.
// Node type-strips this file for the build scripts, so it stays erasable TypeScript with no imports.
export const SUBSCRIPTION_REPO = 'https://github.com/gotgenes/pi-anthropic-auth';
export const SUBSCRIPTION_COMMIT = 'f648e814d479dae75f6e403d8ffa8ae5bc918783';
// pluginDigest (scripts/subscription-plugin.mjs) of the commit's package.json, LICENSE and src/
export const SUBSCRIPTION_PLUGIN_SHA256 = '31eb74900a1f0589e89ebe00905903ede1cec4ad6da7f83f1c96964e249bac92';
