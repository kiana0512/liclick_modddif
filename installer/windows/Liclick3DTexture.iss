#ifndef SourceRoot
#define SourceRoot "..\..\dist-installer\staging"
#endif

#define MyAppName "Liclick 3D Texture"
#ifndef MyAppVersion
#define MyAppVersion "0.1.0"
#endif
#define MyPublisher "Liclick"

[Setup]
AppId={{A2857A8F-9779-47E9-9C7B-FE3B6BBE64B7}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyPublisher}
DefaultDirName={autopf}\Liclick 3D Texture
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64
SetupIconFile={#SourceRoot}\assets\liclick-icon.ico
UninstallDisplayIcon={app}\assets\liclick-icon.ico
OutputDir=..\..\dist-installer
OutputBaseFilename=Liclick 3D Texture Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[InstallDelete]
Type: filesandordirs; Name: "{app}\*"

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\electron\Liclick 3D Texture.exe"; Parameters: """{app}\apps\desktop\main.mjs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\liclick-icon.ico"
Name: "{group}\{#MyAppName} CLI"; Filename: "{app}\scripts\windows-desktop-launcher.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\assets\liclick-icon.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\electron\Liclick 3D Texture.exe"; Parameters: """{app}\apps\desktop\main.mjs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\liclick-icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\electron\Liclick 3D Texture.exe"; Parameters: """{app}\apps\desktop\main.mjs"""; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent unchecked

[Code]
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM "Liclick 3D Texture.exe" /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;
