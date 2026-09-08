#!/bin/bash
# Compile build/installer.nsh, and check it says what requirement 6 requires it to say.
#
# Not part of `npm run test:all`: it needs NSIS, which a machine running the test suite
# may not have, and a gate that silently skips a level is worse than one that never
# claimed it (07_TEST_PLAN.md §1).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
NSH="$ROOT/build/installer.nsh"
fails=0

check() { if [ "$1" = "0" ]; then echo "  ok   $2"; else echo " FAIL  $2"; fails=$((fails+1)); fi; }

echo "— the macros compile —"
if command -v makensis >/dev/null; then
  out="$(cd "$HERE" && makensis -V2 check.nsi 2>&1)"
  status=$?
  check "$status" "makensis accepts build/installer.nsh"
  [ "$status" = "0" ] || echo "$out"
  echo "$out" | grep -q "warning" && echo "        $(echo "$out" | grep warning | head -3)"
else
  echo "  --   makensis is not installed; skipping the compile"
fi

echo
echo "— requirement 6: the uninstaller never removes the store's data —"
grep -q 'LOCALAPPDATA\\ChachiAgrivetPOS' "$NSH"; check $? "the uninstall message names where the database stays"
grep -q 'backup folder is not touched' "$NSH"; check $? "and says the backup folder is untouched"
! grep -qE 'RMDir[^\n]*LOCALAPPDATA' "$NSH"; check $? "no macro deletes the application data folder"
! grep -qiE 'Delete[^\n]*agrivet\.db' "$NSH"; check $? "no macro deletes the database"

echo
echo "— requirement 1 and NFR_5.1 —"
! grep -qi 'RequestExecutionLevel admin' "$NSH"; check $? "no macro asks for administrator rights"
! grep -qiE 'nsExec|ExecShell.*http|inetc::' "$NSH"; check $? "the installer reaches for no network"

echo
node -e '
const b = require("'"$ROOT"'/package.json").build;
const fail = (m) => { console.log(" FAIL  " + m); process.exitCode = 1; };
const ok = (m) => console.log("  ok   " + m);
b.win.requestedExecutionLevel === "asInvoker" ? ok("asInvoker") : fail("asInvoker");
b.nsis.oneClick === false ? ok("oneClick: false") : fail("oneClick: false");
b.nsis.allowToChangeInstallationDirectory ? ok("the install directory is selectable") : fail("selectable install directory");
b.nsis.createDesktopShortcut ? ok("desktop shortcut") : fail("desktop shortcut");
b.nsis.createStartMenuShortcut ? ok("start-menu shortcut") : fail("start-menu shortcut");
b.nsis.deleteAppDataOnUninstall === false ? ok("uninstall keeps the data folder") : fail("deleteAppDataOnUninstall must be false");
b.nsis.include === "build/installer.nsh" ? ok("the macros are included in the build") : fail("installer.nsh is not included");
b.win.publish === null ? ok("no publish target — NFR_5.1, nothing can self-update") : fail("a publish target would enable auto-update");
b.artifactName.includes("ChachiAgrivetPOS-Setup-") ? ok("artifact name") : fail("artifact name");
' || fails=$((fails+1))

echo
[ "$fails" = "0" ] && echo "ALL GREEN" || echo "$fails FAILED"
exit $((fails > 0))
