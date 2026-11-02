#!/bin/sh
# BROWSER in a terminal Damocles opened on this host: the address goes to Damocles, which asks before opening it
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P) || exit 1
node=$root/node/node
cli=$root/dist/cli-remote.js
case $(uname -s) in
  # Git Bash, MSYS2 or Cygwin on a Windows host: Windows Node reads cli-remote.js only by its Windows path
  MINGW* | MSYS* | CYGWIN*)
    node=$node.exe
    if command -v cygpath > /dev/null 2>&1; then cli=$(cygpath -m "$cli") || exit 1; fi
    ;;
esac
exec "$node" "$cli" --open-external "$@"
