#ifndef SourceRoot
#define SourceRoot "..\..\dist-installer\staging"
#endif

#define MyAppName "LIclick 3D Texture"
#ifndef MyAppVersion
#define MyAppVersion "0.1.0"
#endif
#ifndef AtlasSkillhubVersion
#define AtlasSkillhubVersion "latest"
#endif
#ifndef AtlasSkillhubRegistry
#define AtlasSkillhubRegistry "https://registry-cnpm.lilithgame.com/"
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
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "installers\*"
Source: "{#SourceRoot}\installers\node-installer.msi"; DestDir: "{tmp}"; DestName: "node-installer.msi"; Flags: deleteafterinstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\electron\Liclick 3D Texture.exe"; Parameters: """{app}\apps\desktop\main.mjs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\liclick-icon.ico"
Name: "{group}\{#MyAppName} CLI"; Filename: "{app}\scripts\windows-desktop-launcher.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\assets\liclick-icon.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\electron\Liclick 3D Texture.exe"; Parameters: """{app}\apps\desktop\main.mjs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\liclick-icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\electron\Liclick 3D Texture.exe"; Parameters: """{app}\apps\desktop\main.mjs"""; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent unchecked

[Code]
function NodeAlreadyInstalled(): Boolean;
begin
  Result :=
    FileExists('C:\Program Files\nodejs\node.exe') or
    FileExists('C:\Program Files (x86)\nodejs\node.exe');
end;

function GetNpmPath(): String;
begin
  if FileExists('C:\Program Files\nodejs\npm.cmd') then
    Result := 'C:\Program Files\nodejs\npm.cmd'
  else if FileExists('C:\Program Files (x86)\nodejs\npm.cmd') then
    Result := 'C:\Program Files (x86)\nodejs\npm.cmd'
  else
    Result := 'npm';
end;

function AtlasSkillhubPath(): String;
begin
  Result := ExpandConstant('{userappdata}\npm\node_modules\@lilith\atlas-skillhub\dist\index.js');
  if FileExists(Result) then Exit;

  Result := ExpandConstant('{app}\node_modules\@lilith\atlas-skillhub\dist\index.js');
  if FileExists(Result) then Exit;

  Result := '';
end;

function IsAtlasSkillhubInstalled(): Boolean;
begin
  Result := AtlasSkillhubPath() <> '';
end;

procedure AddUserPathDir(Dir: String);
var
  ExistingPath: String;
  NextPath: String;
begin
  if Dir = '' then Exit;
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', ExistingPath) then
    ExistingPath := '';

  if Pos(Uppercase(Dir), Uppercase(ExistingPath)) > 0 then Exit;

  if ExistingPath = '' then
    NextPath := Dir
  else
    NextPath := ExistingPath + ';' + Dir;

  RegWriteStringValue(HKCU, 'Environment', 'Path', NextPath);
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM "Liclick 3D Texture.exe" /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  NpmPath: String;
  NpmPrefix: String;
  LogsDir: String;
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then Exit;

  LogsDir := ExpandConstant('{app}\logs');
  ForceDirectories(LogsDir);

  if not NodeAlreadyInstalled() then begin
    WizardForm.StatusLabel.Caption := '正在安装 Node.js，请稍候...';
    Exec(
      'msiexec.exe',
      '/i "' + ExpandConstant('{tmp}\node-installer.msi') + '" /quiet /norestart',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    );
    if ResultCode <> 0 then begin
      MsgBox(
        'Node.js 安装失败（错误代码 ' + IntToStr(ResultCode) + '）。' + #13#10 +
        '请从 https://nodejs.org 手动安装后，再运行：' + #13#10 +
        '  npm install -g --prefix "' + ExpandConstant('{userappdata}\npm') + '" @lilith/atlas-skillhub@{#AtlasSkillhubVersion} --registry={#AtlasSkillhubRegistry}',
        mbError,
        MB_OK
      );
      Exit;
    end;
  end;

  NpmPrefix := ExpandConstant('{userappdata}\npm');
  ForceDirectories(NpmPrefix);
  AddUserPathDir('C:\Program Files\nodejs');
  AddUserPathDir(NpmPrefix);

  if IsAtlasSkillhubInstalled() then begin
    WizardForm.StatusLabel.Caption := '@lilith/atlas-skillhub 已安装。';
    Exit;
  end;

  NpmPath := GetNpmPath();
  WizardForm.StatusLabel.Caption := '正在安装 @lilith/atlas-skillhub，请稍候...';
  Exec(
    ExpandConstant('{cmd}'),
    '/C ""' + NpmPath + '" install -g --prefix "' + NpmPrefix + '" @lilith/atlas-skillhub@{#AtlasSkillhubVersion} --registry={#AtlasSkillhubRegistry} > "' + LogsDir + '\atlas-skillhub-install.log" 2>&1"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
  if ResultCode <> 0 then
    MsgBox(
      '@lilith/atlas-skillhub 安装失败。安装日志：' + LogsDir + '\atlas-skillhub-install.log' + #13#10 +
      '请稍后手动执行：' + #13#10 +
      '  npm install -g --prefix "' + NpmPrefix + '" @lilith/atlas-skillhub@{#AtlasSkillhubVersion} --registry={#AtlasSkillhubRegistry}',
      mbInformation,
      MB_OK
    );
end;
