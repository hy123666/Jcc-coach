Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "JCC uninstall fixture"
OutFile "${FIXTURE_ROOT}\maker.exe"
!include MUI2.nsh
!include FileFunc.nsh
!include Sections.nsh
!include LogicLib.nsh
Var installMode
Var fixtureMode
Var fixtureUpdated
!define isUpdated '$fixtureUpdated == "1"'
!define BUILD_UNINSTALLER
!include "${REPO_ROOT}\ui\installer\uninstall-user-data.nsh"
!define MUI_COMPONENTSPAGE_NODESC
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.FixtureAdvance
!insertmacro MUI_UNPAGE_COMPONENTS
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Make fixture"
  WriteUninstaller "${FIXTURE_ROOT}\fixture-uninstall.exe"
SectionEnd

Section "un.Uninstall fixture"
  SectionIn RO
  !insertmacro customUnInstall
  FileOpen $0 "${FIXTURE_ROOT}\ran.txt" w
  FileWrite $0 "ran"
  FileClose $0
SectionEnd

Function un.onInit
  SetAutoClose true
  StrCpy $installMode "current"
  !insertmacro customUnInit
  ; Only this test executable replaces paths; production has no override.
  StrCpy $JccUserDataDirectory "${FIXTURE_ROOT}\profile\jcc-runtime-ui"
  StrCpy $JccLogDirectory "${FIXTURE_ROOT}\logs\jcc-runtime-ui"
  ${GetOptions} $CMDLINE "/CASE=" $fixtureMode
  StrCpy $fixtureUpdated "0"
  ${If} $fixtureMode == "updated"
    StrCpy $fixtureUpdated "1"
  ${EndIf}
  SectionGetFlags ${JCC_DELETE_USER_DATA} $1
  IntOp $1 $1 & ${SF_SELECTED}
  FileOpen $0 "${FIXTURE_ROOT}\default.txt" w
  FileWrite $0 $1
  FileClose $0
  ${If} $fixtureMode != "default"
    !insertmacro SelectSection ${JCC_DELETE_USER_DATA}
  ${EndIf}
FunctionEnd

Function un.FixtureAdvance
  ${If} $fixtureMode == "cancel"
    Quit
  ${EndIf}
  FileOpen $0 "${FIXTURE_ROOT}\shown.txt" w
  FileWrite $0 $fixtureMode
  FileClose $0
  ; Tests set native section flags in onInit, then skip interactive navigation.
  Abort
FunctionEnd
