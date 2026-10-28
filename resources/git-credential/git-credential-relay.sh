#!/bin/sh
# git runs this as its last credential.helper with the operation (get, store or erase) as its one argument.
ELECTRON_RUN_AS_NODE=1 exec "$DAMOCLES_ASKPASS_NODE" "$DAMOCLES_ASKPASS_MAIN" credential "$@"
