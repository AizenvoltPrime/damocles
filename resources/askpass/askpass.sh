#!/bin/sh
# git runs this as GIT_ASKPASS with its prompt as the one argument; the answer is the helper's stdout.
ELECTRON_RUN_AS_NODE=1 exec "$DAMOCLES_ASKPASS_NODE" "$DAMOCLES_ASKPASS_MAIN" askpass "$@"
