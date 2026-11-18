; Installer hooks (bundle.windows.nsis.installerHooks in tauri.windows.conf.json).
;
; Registers the Explorer add-in (ezreader_shell.dll, src-tauri/shell-ext):
; page 1 of each PDF as its icon, and the pages in the preview pane (Alt+P),
; which PowerToys Peek also uses. Keep the class ids in step with
; shell-ext/src/lib.rs and AppxManifest.xml.

!define EZ_SHELL_DLL "ezreader_shell.dll"
; Built by `npm run build:shell-ext` (part of the Windows beforeBuildCommand).
; Not a Tauri resource: Tauri would then require the DLL for every cargo build.
!define EZ_SHELL_DLL_SOURCE "${__FILEDIR__}\..\shell-ext\target\release\ezreader_shell.dll"
!define EZ_THUMB_CLSID "{5AE37068-61BA-478F-9D24-EA58E7C1EBF6}"
!define EZ_PREVIEW_CLSID "{202348CF-BD0B-4EB3-91B2-C87E74F2FD32}"
; Explorer's slots for a file type's thumbnail provider and preview handler.
!define EZ_THUMB_SLOT "{e357fccd-a995-4576-b01f-234630154e96}"
!define EZ_PREVIEW_SLOT "{8895b1c6-b41f-4c1c-a562-0d564250836f}"
; prevhost.exe, the 64-bit process Windows runs preview handlers in.
!define EZ_PREVHOST_APPID "{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}"
!define EZ_PREVIEW_HANDLERS "Software\Microsoft\Windows\CurrentVersion\PreviewHandlers"

; Explorer may hold the DLL loaded (thumbnail and preview hosts): a loaded
; DLL cannot be overwritten or deleted, but it can be renamed. The old copy
; goes at the next restart.
!macro EZ_MOVE_SHELL_DLL_ASIDE
  ${If} ${FileExists} "$INSTDIR\${EZ_SHELL_DLL}"
    Delete "$INSTDIR\${EZ_SHELL_DLL}.old"
    Rename "$INSTDIR\${EZ_SHELL_DLL}" "$INSTDIR\${EZ_SHELL_DLL}.old"
    Delete /REBOOTOK "$INSTDIR\${EZ_SHELL_DLL}.old"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro EZ_MOVE_SHELL_DLL_ASIDE
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath $INSTDIR
  File "${EZ_SHELL_DLL_SOURCE}"
  ${If} ${FileExists} "$INSTDIR\${EZ_SHELL_DLL}"
    ; Class ids live in the 64-bit view (the installer itself is 32-bit).
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
    ; Tell Explorer that file type handlers changed (SHCNE_ASSOCCHANGED).
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetRegView 64
  ; Only free Explorer's slots if they still point to EzReader.
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
!macroend
