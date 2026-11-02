; electron-builder's nsis.include: the damocles command's entry in the user's Path, which Damocles.exe edits itself
; (src/desktop/main/cli-path.ts, docs/invariants.md "The damocles command"). nsExec waits for it to exit; a failure is shown in
; the details and the log, and never fails the install.

!macro customInstall
  nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cli-path add'
  Pop $0
  DetailPrint "Adding the damocles command to Path ended with exit code $0."
!macroend

!macro customUnInstall
  ; electron-builder runs the old uninstaller during every update, which must leave the entry to the new version
  ${ifNot} ${isUpdated}
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cli-path remove'
    Pop $0
    DetailPrint "Removing the damocles command from Path ended with exit code $0."
  ${endIf}
!macroend
