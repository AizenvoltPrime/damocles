@echo off
rem Damocles' credential helper: the relay's last helper on a target, the only one for a managed URL. git passes the
rem operation (get, store or erase) last, after --takeover for a managed URL.
rem DisableDelayedExpansion: a registry DelayedExpansion=1 would eat a ! in the paths.
setlocal DisableDelayedExpansion
set ELECTRON_RUN_AS_NODE=1
"%DAMOCLES_ASKPASS_NODE%" "%DAMOCLES_ASKPASS_MAIN%" credential %*
