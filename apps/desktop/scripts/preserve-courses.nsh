; Course files live beside the executable. NSIS must preserve them across removal/update.
!macro sylloraRestoreCourses
  ${If} $SylloraPreserveRoot != ""
    CreateDirectory "$INSTDIR"
    ClearErrors
    Rename "$SylloraPreserveRoot" "$INSTDIR\.syllora"
    ${If} ${Errors}
      Abort "Course files are preserved at $SylloraPreserveRoot; restore them before retrying."
    ${EndIf}
    StrCpy $SylloraPreserveRoot ""
  ${EndIf}
!macroend

!macro customRemoveFiles
  Var /GLOBAL SylloraPreserveRoot
  StrCpy $SylloraPreserveRoot ""
  ${If} ${FileExists} "$INSTDIR\.syllora\*.*"
    ${If} ${FileExists} "$INSTDIR.syllora-preserved\*.*"
      Abort "An earlier course backup exists at $INSTDIR.syllora-preserved; removal has stopped."
    ${EndIf}
    ClearErrors
    Rename "$INSTDIR\.syllora" "$INSTDIR.syllora-preserved"
    ${If} ${Errors}
      Abort "Cannot preserve course files; application removal has stopped."
    ${EndIf}
    StrCpy $SylloraPreserveRoot "$INSTDIR.syllora-preserved"
  ${EndIf}

  ; Retain electron-builder's atomic update/rollback path for application binaries.
  ${If} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    Push ""
    Call un.atomicRMDir
    Pop $R0
    ${If} $R0 != 0
      Push ""
      Call un.restoreFiles
      Pop $R0
      !insertmacro sylloraRestoreCourses
      Abort "Application files are busy; removal has stopped."
    ${EndIf}
  ${EndIf}
  SetOutPath $TEMP
  RMDir /r "$INSTDIR"
  !insertmacro sylloraRestoreCourses
!macroend
