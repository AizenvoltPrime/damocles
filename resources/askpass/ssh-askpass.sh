#!/bin/sh
# ssh runs this as SSH_ASKPASS (SSH_ASKPASS_REQUIRE=force) with its prompt as the one argument.
ELECTRON_RUN_AS_NODE=1 exec "$DAMOCLES_ASKPASS_NODE" "$DAMOCLES_ASKPASS_MAIN" ssh "$@"
