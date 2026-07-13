; Mangaplay Studio NSIS installer template
; Overrides Tauri 2 default NSIS template

!define PRODUCT_NAME "Mangaplay Studio"
!define PRODUCT_PUBLISHER "Mangaplay Studio"

; Install scope — per-user (no admin needed)
RequestExecutionLevel user

; Install directory
InstallDir "$LOCALAPPDATA\${PRODUCT_NAME}"

; License page
!insertmacro MUI_PAGE_LICENSE "${BUILD_RESOURCES_DIR}\LICENSE.md"

; Desktop shortcut checkbox on finish page
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut

Function CreateDesktopShortcut
    CreateShortCut "$DESKTOP\Mangaplay Studio.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
FunctionEnd

; Start Menu shortcut
!define MUI_STARTMENUPAGE_REGISTRY_ROOT "HKCU"
!define MUI_STARTMENUPAGE_REGISTRY_KEY "Software\${PRODUCT_NAME}"
!define MUI_STARTMENUPAGE_REGISTRY_VALUENAME "Start Menu Folder"

; Don't add to PATH
!define MUI_FINISHPAGE_NOAUTOCLOSE
