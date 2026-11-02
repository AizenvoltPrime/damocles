@echo off
rem damocles in a terminal Damocles opened on this host: the server package's own Node sends the request to Damocles
rem DisableDelayedExpansion: a registry DelayedExpansion=1 would eat a ! in the arguments.
setlocal DisableDelayedExpansion
"%~dp0..\..\node\node.exe" "%~dp0..\..\dist\cli-remote.js" %*
endlocal & exit /b %ERRORLEVEL%
