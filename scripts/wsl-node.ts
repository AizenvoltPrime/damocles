/**
 * The bash lines a WSL build runs before npm: nvm's Node 24 when the distro has nvm, which a login shell does not load from
 * the interactive rc file, then a probe that stops the build on a Node before 24, the version CI builds with and the
 * scripts' type stripping needs (22.18 or later).
 */
export const WSL_NODE_SETUP: readonly string[] = [
  'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use 24 >/dev/null 2>&1 || true; fi',
  `node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || { echo "Node 24 or later is required in the distro (found $(node --version 2>&1))"; exit 1; }`,
];
