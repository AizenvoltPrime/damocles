@echo off
rem damocles on Windows: the app's binary runs dist/cli.js as Node, as VS Code's code.cmd runs cli.js
rem DisableDelayedExpansion: a registry DelayedExpansion=1 would eat a ! in the arguments.
setlocal DisableDelayedExpansion
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Damocles.exe" "%~dp0..\app.asar.unpacked\dist\cli.js" %*
endlocal & exit /b %ERRORLEVEL%
