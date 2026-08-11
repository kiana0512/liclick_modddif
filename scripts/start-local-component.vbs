Option Explicit
Dim shell, fso, scriptDir, appRoot, nodeExe, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
appRoot = fso.GetParentFolderName(scriptDir)
nodeExe = fso.BuildPath(fso.BuildPath(appRoot, "node"), "node.exe")
If Not fso.FileExists(nodeExe) Then
  nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
End If
If Not fso.FileExists(nodeExe) Then
  nodeExe = "node"
End If
launcher = fso.BuildPath(scriptDir, "windows-local-component.mjs")
shell.Run Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & launcher & Chr(34), 0, False
