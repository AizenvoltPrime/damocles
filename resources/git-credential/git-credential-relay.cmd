@echo off
rem git runs this as its last credential.helper with the operation (get, store or erase) as its one argument.
rem DisableDelayedExpansion: a registry DelayedExpansion=1 would eat a ! in the paths.
setlocal DisableDelayedExpansion
set ELECTRON_RUN_AS_NODE=1
"%DAMOCLES_ASKPASS_NODE%" "%DAMOCLES_ASKPASS_MAIN%" credential %1
