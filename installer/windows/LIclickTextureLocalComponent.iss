#ifndef SourceRoot
#define SourceRoot "..\..\dist-local-component\staging"
#endif

#ifndef MyAppVersion
#define MyAppVersion "0.1.3"
#endif

#define MyAppName "LIclick 3D Texture Local Component"
#define MyPublisher "LIclick"

[Setup]
AppId={{D853CBB5-97FD-467B-A976-87AC3D1AE36A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyPublisher}
DefaultDirName={localappdata}\Programs\LIclick 3D Texture Local Component
DisableDirPage=no
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile={#SourceRoot}\assets\liclick-icon.ico
UninstallDisplayIcon={app}\assets\liclick-icon.ico
OutputDir=..\..\dist-local-component
OutputBaseFilename=LIclick 3D Texture Local Component Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\启动本地贴图组件"; Filename: "{sys}\wscript.exe"; Parameters: "//B //Nologo ""{app}\scripts\start-local-component.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\liclick-icon.ico"
Name: "{group}\本地组件日志"; Filename: "{localappdata}\LIclick 3D Texture Local Component\logs"
Name: "{group}\卸载本地贴图组件"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "LIclick3DTextureLocalComponent"; ValueData: """{sys}\wscript.exe"" //B //Nologo ""{app}\scripts\start-local-component.vbs"""; Flags: uninsdeletevalue

[Run]
Filename: "{sys}\wscript.exe"; Parameters: "//B //Nologo ""{app}\scripts\start-local-component.vbs"""; Flags: nowait runhidden skipifdoesntexist

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\scripts\stop-local-component.mjs"""; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "StopLocalTextureComponent"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ExistingNode: String;
  ExistingStopScript: String;
begin
  if CurStep = ssInstall then
  begin
    ExistingNode := ExpandConstant('{app}\node\node.exe');
    ExistingStopScript := ExpandConstant('{app}\scripts\stop-local-component.mjs');
    if FileExists(ExistingNode) and FileExists(ExistingStopScript) then
      Exec(ExistingNode, '"' + ExistingStopScript + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
