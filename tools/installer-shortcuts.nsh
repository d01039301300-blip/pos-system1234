!macro customInstall
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\system-app-icon.ico" 0
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\system-app-icon.ico" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "هل تريد حذف بيانات البرنامج وقاعدة البيانات؟\r\nاختر No للاحتفاظ بها." IDNO keep_data
  RMDir /r "$APPDATA\SystemPOS"
keep_data:
!macroend
