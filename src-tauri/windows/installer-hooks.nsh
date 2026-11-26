!define EZ_SHELL_DLL "ezreader_shell.dll"
!define EZ_SHELL_DLL_SOURCE "${__FILEDIR__}\..\shell-ext\target\release\ezreader_shell.dll"
!define EZ_QUICK_LOOK "ezreader-quicklook.exe"
!define EZ_QUICK_LOOK_SOURCE "${__FILEDIR__}\..\shell-ext\target\release\ezreader-quicklook.exe"
!define EZ_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define EZ_RUN_VALUE "EzReader Quick Look"
!define EZ_THUMB_CLSID "{5AE37068-61BA-478F-9D24-EA58E7C1EBF6}"
!define EZ_PREVIEW_CLSID "{202348CF-BD0B-4EB3-91B2-C87E74F2FD32}"
!define EZ_THUMB_SLOT "{e357fccd-a995-4576-b01f-234630154e96}"
!define EZ_PREVIEW_SLOT "{8895b1c6-b41f-4c1c-a562-0d564250836f}"
!define EZ_PREVHOST_APPID "{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}"
!define EZ_PREVIEW_HANDLERS "Software\Microsoft\Windows\CurrentVersion\PreviewHandlers"

!macro EZ_MOVE_ASIDE NAME
  ${If} ${FileExists} "$INSTDIR\${NAME}"
    Delete "$INSTDIR\${NAME}.old"
    Rename "$INSTDIR\${NAME}" "$INSTDIR\${NAME}.old"
    Delete /REBOOTOK "$INSTDIR\${NAME}.old"
  ${EndIf}
!macroend

!macro EZ_MOVE_SHELL_DLL_ASIDE
  !insertmacro EZ_MOVE_ASIDE "${EZ_SHELL_DLL}"
!macroend

!macro EZ_STOP_QUICK_LOOK
  ${If} ${FileExists} "$INSTDIR\${EZ_QUICK_LOOK}"
    ExecWait '"$INSTDIR\${EZ_QUICK_LOOK}" --stop'
    Sleep 500
    !insertmacro EZ_MOVE_ASIDE "${EZ_QUICK_LOOK}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro EZ_STOP_QUICK_LOOK
  !insertmacro EZ_MOVE_SHELL_DLL_ASIDE
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath $INSTDIR
  File "${EZ_SHELL_DLL_SOURCE}"
  File "${EZ_QUICK_LOOK_SOURCE}"
  ReadRegStr $0 HKCU "${EZ_RUN_KEY}" "${EZ_RUN_VALUE}"
  ${If} $0 != ""
    WriteRegStr HKCU "${EZ_RUN_KEY}" "${EZ_RUN_VALUE}" '"$INSTDIR\${EZ_QUICK_LOOK}"'
    Exec '"$INSTDIR\${EZ_QUICK_LOOK}"'
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\${EZ_SHELL_DLL}"
    SetRegView 64

    WriteRegStr SHCTX "Software\Classes\CLSID\${EZ_THUMB_CLSID}" "" "EzReader PDF thumbnails"
    WriteRegStr SHCTX "Software\Classes\CLSID\${EZ_THUMB_CLSID}\InprocServer32" "" "$INSTDIR\${EZ_SHELL_DLL}"
    WriteRegStr SHCTX "Software\Classes\CLSID\${EZ_THUMB_CLSID}\InprocServer32" "ThreadingModel" "Apartment"
    WriteRegStr SHCTX "Software\Classes\.pdf\ShellEx\${EZ_THUMB_SLOT}" "" "${EZ_THUMB_CLSID}"

    WriteRegStr SHCTX "Software\Classes\CLSID\${EZ_PREVIEW_CLSID}" "" "EzReader PDF preview"
    WriteRegStr SHCTX "Software\Classes\CLSID\${EZ_PREVIEW_CLSID}" "AppID" "${EZ_PREVHOST_APPID}"
    WriteRegStr SHCTX "Software\Classes\CLSID\${EZ_PREVIEW_CLSID}\InprocServer32" "" "$INSTDIR\${EZ_SHELL_DLL}"
    WriteRegStr SHCTX "Software\Classes\CLSID\${EZ_PREVIEW_CLSID}\InprocServer32" "ThreadingModel" "Apartment"
    WriteRegStr SHCTX "Software\Classes\.pdf\ShellEx\${EZ_PREVIEW_SLOT}" "" "${EZ_PREVIEW_CLSID}"
    WriteRegStr SHCTX "${EZ_PREVIEW_HANDLERS}" "${EZ_PREVIEW_CLSID}" "EzReader PDF preview"

    SetRegView lastused
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetRegView 64
  ReadRegStr $0 SHCTX "Software\Classes\.pdf\ShellEx\${EZ_THUMB_SLOT}" ""
  ${If} $0 == "${EZ_THUMB_CLSID}"
    DeleteRegKey SHCTX "Software\Classes\.pdf\ShellEx\${EZ_THUMB_SLOT}"
  ${EndIf}
  ReadRegStr $0 SHCTX "Software\Classes\.pdf\ShellEx\${EZ_PREVIEW_SLOT}" ""
  ${If} $0 == "${EZ_PREVIEW_CLSID}"
    DeleteRegKey SHCTX "Software\Classes\.pdf\ShellEx\${EZ_PREVIEW_SLOT}"
  ${EndIf}
  DeleteRegKey /ifempty SHCTX "Software\Classes\.pdf\ShellEx"
  DeleteRegValue SHCTX "${EZ_PREVIEW_HANDLERS}" "${EZ_PREVIEW_CLSID}"
  DeleteRegKey SHCTX "Software\Classes\CLSID\${EZ_THUMB_CLSID}"
  DeleteRegKey SHCTX "Software\Classes\CLSID\${EZ_PREVIEW_CLSID}"
  SetRegView lastused
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  !insertmacro EZ_MOVE_SHELL_DLL_ASIDE
  !insertmacro EZ_STOP_QUICK_LOOK
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${EZ_RUN_KEY}" "${EZ_RUN_VALUE}"
  ${EndIf}
!macroend
