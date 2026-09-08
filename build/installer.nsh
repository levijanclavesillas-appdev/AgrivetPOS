; NSIS customisation for ChachiAgrivetPOS — TASK-018 requirement 6.
;
; The one thing this file exists to guarantee: **the uninstaller never removes the
; store's data or its backups.** electron-builder's `deleteAppDataOnUninstall: false`
; already stops it deleting %LOCALAPPDATA%\ChachiAgrivetPOS, and the backup folder is
; outside the application data directory by rule (OPS-001) so the installer has never
; known where it is. Both facts are stated on screen rather than left to be discovered,
; because an owner who believes uninstalling deletes their books will not uninstall,
; and one who believes it does not is entitled to be told plainly that it does not.
;
; No administrator rights anywhere in this file (`asInvoker`, requirement 1). Nothing
; here writes outside the install directory.

!macro customWelcomePage
!macroend

; Shown before the files are removed, on the uninstaller's confirmation page.
!macro customUnInstallCheck
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Remove Chachi Agrivet POS from this computer?$\r$\n$\r$\n\
     Your data is NOT removed:$\r$\n$\r$\n\
     • The database stays in$\r$\n\
       $LOCALAPPDATA\ChachiAgrivetPOS$\r$\n$\r$\n\
     • Your backup folder is not touched at all.$\r$\n$\r$\n\
     Reinstalling later will find the same data and carry on where you left off." \
    IDYES continueUninstall
    Abort
  continueUninstall:
!macroend

; Belt and braces over `deleteAppDataOnUninstall: false`. Spelled out so that a future
; change to that flag cannot quietly start deleting a store's books.
!macro customRemoveFiles
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\*.*"
  RMDir "$INSTDIR"
  ; $LOCALAPPDATA\ChachiAgrivetPOS is deliberately absent from this macro.
  ; So is the backup folder, which this installer has never been told the location of.
!macroend

!macro customInstall
  ; NFR_5.1: no auto-update service, no scheduled task, no background updater.
  ; A store PC that self-updates mid-shift is an outage at the counter with a queue in
  ; front of it. Updates arrive as a signed installer, by hand or on a USB stick.
!macroend
