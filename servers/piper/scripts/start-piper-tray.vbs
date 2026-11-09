' Old name of start-voicedock-tray.vbs (the tray had an older name up to
' VoiceDock 1.1). Kept so a startup shortcut from then still works;
' the tray replaces that shortcut with "VoiceDock Tray" when it starts.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
sh.Run "wscript """ & fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-voicedock-tray.vbs") & """", 0, False
