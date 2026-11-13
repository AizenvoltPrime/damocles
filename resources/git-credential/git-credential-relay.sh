#!/bin/sh
# Damocles' credential helper: the relay's last helper on a target, the only one for a managed URL. git passes the
# operation (get, store or erase) last, after --takeover for a managed URL.
ELECTRON_RUN_AS_NODE=1 exec "$DAMOCLES_ASKPASS_NODE" "$DAMOCLES_ASKPASS_MAIN" credential "$@"
