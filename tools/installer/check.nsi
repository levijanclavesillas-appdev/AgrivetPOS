; A harness that compiles build/installer.nsh on its own.
;
; electron-builder assembles the real installer script from its own template plus our
; macros, and it needs wine to do that on a build machine that is not Windows. This
; compiles the half that was hand-written, which is the half that can be wrong — a
; syntax error in a macro body fails only at release time, on the release machine,
; when there is nothing to do but guess at it.
;
;   makensis tools/installer/check.nsi
;
; It emits a throwaway binary and proves nothing about the finished installer. What it
; proves is that every macro in build/installer.nsh parses and that its bodies compile.

Name "ChachiAgrivetPOS installer macro check"
OutFile "chachi-nsh-check.exe"
InstallDir "$LOCALAPPDATA\ChachiAgrivetPOS"
RequestExecutionLevel user          ; requirement 1: asInvoker, never administrator

!include "..\..\build\installer.nsh"

Function .onInit
  !insertmacro customWelcomePage
FunctionEnd

Section "Install"
  !insertmacro customInstall
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  !insertmacro customUnInstallCheck
  !insertmacro customRemoveFiles
SectionEnd
