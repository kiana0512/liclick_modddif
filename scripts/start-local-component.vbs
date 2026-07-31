Option Explicit
Dim shell, fso, scriptDir, appRoot, nodeExe, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
appRoot = fso.GetParentFolderName(scriptDir)
nodeExe = fso.BuildPath(fso.BuildPath(appRoot, "node"), "node.exe")
launcher = fso.BuildPath(scriptDir, "windows-local-component.mjs")
shell.Run Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & launcher & Chr(34), 0, False
