!ifndef JCC_UNINSTALL_USER_DATA_INCLUDED
!define JCC_UNINSTALL_USER_DATA_INCLUDED

!ifdef BUILD_UNINSTALLER
Var JccUserDataDirectory
Var JccLogDirectory
Var JccCleanupFailed
!endif

!define MUI_COMPONENTSPAGE_TEXT_TOP "默认保留用户配置和运行数据。只有勾选下方清理选项，才会永久删除本机当前用户的 JCC 数据。"

!macro customUnInit
  ; Resolve current-user paths, never a command-line or Runtime override.
  SetShellVarContext current
  StrCpy $JccUserDataDirectory "$APPDATA\jcc-runtime-ui"
  StrCpy $JccLogDirectory "$TEMP\jcc-runtime-ui"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  !define MUI_COMPONENTSPAGE_NODESC
  !insertmacro MUI_UNPAGE_COMPONENTS
!macroend

!ifdef BUILD_UNINSTALLER
  ; This section only owns the checkbox. The supported customUnInstall hook
  ; performs cleanup after electron-builder checks that the app is stopped.
  Section /o "un.同时删除用户配置和运行数据（无法恢复）" JCC_DELETE_USER_DATA
  SectionEnd
  ; Remove only ordinary children.  RMDir /r follows directory junctions on
  ; Windows, so it must not be used for user-owned data cleanup.
  Function un.JccRemoveOwnedPath
    Exch $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6

    ClearErrors
    System::Call 'kernel32::GetFileAttributes(t r0)i .r1'
    IntCmp $1 -1 jcc_remove_missing jcc_remove_have_attrs jcc_remove_have_attrs

    jcc_remove_missing:
      System::Call 'kernel32::GetLastError() i .r2'
      IntCmp $2 2 jcc_remove_done jcc_remove_missing_not_found jcc_remove_missing_not_found
    jcc_remove_missing_not_found:
      IntCmp $2 3 jcc_remove_done jcc_remove_failed jcc_remove_failed

    jcc_remove_have_attrs:
      ; FILE_ATTRIBUTE_REPARSE_POINT = 0x400.  Unlink a reparse point as
      ; one filesystem entry and never enumerate through it.
      IntOp $2 $1 & 0x400
      IntCmp $2 0 jcc_remove_plain jcc_remove_reparse jcc_remove_reparse

    jcc_remove_reparse:
      IntOp $2 $1 & 0x10
      IntCmp $2 0 jcc_remove_reparse_file jcc_remove_reparse_dir jcc_remove_reparse_dir
    jcc_remove_reparse_file:
      ClearErrors
      Delete "$0"
      IfErrors jcc_remove_failed jcc_remove_done
    jcc_remove_reparse_dir:
      ClearErrors
      RMDir "$0"
      IfErrors jcc_remove_failed jcc_remove_done

    jcc_remove_plain:
      IntOp $2 $1 & 0x10
      IntCmp $2 0 jcc_remove_plain_file jcc_remove_plain_dir jcc_remove_plain_dir
    jcc_remove_plain_file:
      ClearErrors
      Delete "$0"
      IfErrors jcc_remove_failed jcc_remove_done
    jcc_remove_plain_dir:
      ClearErrors
      FindFirst $3 $4 "$0\*"
      IfErrors jcc_remove_plain_dir_close
    jcc_remove_plain_dir_next:
      StrCmp $4 "" jcc_remove_plain_dir_close
      StrCmp $4 "." jcc_remove_plain_dir_skip
      StrCmp $4 ".." jcc_remove_plain_dir_skip
      StrCpy $5 "$0\$4"
      Push $5
      Call un.JccRemoveOwnedPath
    jcc_remove_plain_dir_skip:
      FindNext $3 $4
      IfErrors jcc_remove_plain_dir_close
      Goto jcc_remove_plain_dir_next
    jcc_remove_plain_dir_close:
      FindClose $3
      ClearErrors
      RMDir "$0"
      IfErrors jcc_remove_failed jcc_remove_done

    jcc_remove_failed:
      StrCpy $JccCleanupFailed "1"
    jcc_remove_done:
      Pop $6
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Pop $0
  FunctionEnd

!endif

!macro customUnInstall
    SectionGetFlags ${JCC_DELETE_USER_DATA} $0
    IntOp $0 $0 & 1
    StrCmp $0 0 jcc_cleanup_done
    ${If} ${isUpdated}
      Goto jcc_cleanup_done
    ${EndIf}
    ${If} ${Silent}
      Goto jcc_cleanup_done
    ${EndIf}
    StrCpy $JccCleanupFailed "0"
    StrCmp $JccUserDataDirectory "" jcc_cleanup_invalid
    StrCmp $JccLogDirectory "" jcc_cleanup_invalid

    IfFileExists "$JccUserDataDirectory\." 0 jcc_cleanup_logs
    Push "$JccUserDataDirectory"
    Call un.JccRemoveOwnedPath

    jcc_cleanup_logs:
    IfFileExists "$JccLogDirectory\." 0 jcc_cleanup_check
    Push "$JccLogDirectory"
    Call un.JccRemoveOwnedPath

    jcc_cleanup_check:
    StrCmp $JccCleanupFailed "0" jcc_cleanup_done
    DetailPrint "部分用户数据未能删除，请关闭占用文件的程序后重试。"
    MessageBox MB_OK|MB_ICONEXCLAMATION "部分用户数据未能删除。请关闭占用文件的程序后检查：$\r$\n$JccUserDataDirectory$\r$\n$JccLogDirectory"
    SetErrorLevel 2
    Abort "用户数据清理未完成"

    jcc_cleanup_invalid:
    SetErrorLevel 2
    Abort "无法确定用户数据目录，未执行清理"

    jcc_cleanup_done:
!macroend

!endif
