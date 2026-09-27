Option Explicit

Dim shell, fileSystem, repoRoot, nodeExecutable, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

repoRoot = fileSystem.GetParentFolderName(fileSystem.GetParentFolderName(WScript.ScriptFullName))
nodeExecutable = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If Not fileSystem.FileExists(nodeExecutable) Then
  nodeExecutable = "node.exe"
End If

launcher = fileSystem.BuildPath(repoRoot, "tools\launch-jcc-runtime-electron.mjs")
shell.CurrentDirectory = repoRoot
command = Chr(34) & nodeExecutable & Chr(34) & " " & Chr(34) & launcher & Chr(34)
shell.Run command, 0, False
