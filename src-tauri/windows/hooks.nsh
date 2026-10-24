; Lists action0 as a mail app, so it can be chosen in Windows' "Default apps"
; for mailto: links (Windows never lets an installer make that choice).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Clients\Mail\action0" "" "action0"
  WriteRegStr SHCTX "Software\Clients\Mail\action0\Capabilities" "ApplicationName" "action0"
  WriteRegStr SHCTX "Software\Clients\Mail\action0\Capabilities" "ApplicationDescription" "Mail and calendar"
  WriteRegStr SHCTX "Software\Clients\Mail\action0\Capabilities\URLAssociations" "mailto" "action0.mailto"
  WriteRegStr SHCTX "Software\RegisteredApplications" "action0" "Software\Clients\Mail\action0\Capabilities"
  WriteRegStr SHCTX "Software\Classes\action0.mailto" "" "URL:MailTo Protocol"
  WriteRegStr SHCTX "Software\Classes\action0.mailto" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\action0.mailto\shell\open\command" "" '"$INSTDIR\action0.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Clients\Mail\action0"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "action0"
  DeleteRegKey SHCTX "Software\Classes\action0.mailto"
!macroend
