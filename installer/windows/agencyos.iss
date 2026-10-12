; AgencyOS for Windows - Inno Setup script.
;
; Build (see installer/windows/build.ps1 and .github/workflows/windows-installer.yml):
;   ISCC.exe /DAppVersion=1.0.0 /DStageDir=C:\stage /DOutDir=C:\out /DIconFile=C:\icon.ico agencyos.iss
;
; Installs for the current user only (no administrator rights, no UAC prompt). The program goes
; to %LOCALAPPDATA%\Programs\AgencyOS; the person's data (database, uploads, AI models, logs)
; lives in %LOCALAPPDATA%\AgencyOS and is never touched by an upgrade.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0.0"
#endif
#ifndef Compression
  #define Compression "lzma2/max"
#endif
#ifndef StageDir
  #error StageDir is required (the folder produced by the staging scripts)
#endif
#ifndef OutDir
  #define OutDir "."
#endif
#ifndef IconFile
  #define IconFile "..\desktop\assets\icon.ico"
#endif

#define AppName "AgencyOS"
#define AppExe "AgencyOS.exe"

[Setup]
AppId={{B6D5A1B3-6C0A-4F6E-9D55-3A3F0B5E7A11}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=AgencyOS
AppComments=Advertising agency platform that runs on this computer
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutDir}
OutputBaseFilename=AgencyOS-Setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
LicenseFile={#StageDir}\LICENSE.txt
InfoAfterFile={#StageDir}\THIRD_PARTY_NOTICES.txt
Compression={#Compression}
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
SetupLogging=yes
UsePreviousAppDir=yes
CloseApplications=no
RestartApplications=no
VersionInfoVersion={#NumericVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start {#AppName} when I &sign in to Windows (keeps scheduled campaigns running)"; GroupDescription: "Background operation:"
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; Excludes: ".tmp-runtime\*"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; AppUserModelID: "com.agencyos.desktop"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon; AppUserModelID: "com.agencyos.desktop"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"" --hidden"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Files the program creates while running (the web server's cache) are not in the install list.
Type: filesandordirs; Name: "{app}"

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#AppExe} /F"; Flags: runhidden; RunOnceId: "CloseAgencyOSWindow"
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\launcher\agencyos.mjs"" stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopAgencyOSServices"

[Code]
// Before files are replaced (an upgrade) the running app and its services must be stopped.
procedure StopRunningAgencyOS();
var
  Code: Integer;
  Node, Script: String;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#AppExe} /F', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Node := ExpandConstant('{app}\runtime\node\node.exe');
  Script := ExpandConstant('{app}\launcher\agencyos.mjs');
  if FileExists(Node) and FileExists(Script) then
    Exec(Node, '"' + Script + '" stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningAgencyOS();
  Result := '';
end;

// The uninstaller keeps the person's data unless they ask for it to go (silent: /PURGEDATA=1).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  Purge: Boolean;
  Attempt: Integer;
begin
  // Make sure nothing is still running (and holding files open) before anything is removed.
  if CurUninstallStep = usUninstall then StopRunningAgencyOS();
  if CurUninstallStep <> usPostUninstall then Exit;
  DataDir := ExpandConstant('{localappdata}\AgencyOS');
  if not DirExists(DataDir) then Exit;
  if UninstallSilent then
    Purge := ExpandConstant('{param:PURGEDATA|0}') = '1'
  else
    Purge := MsgBox('Also delete your AgencyOS data (database, uploads, downloaded AI models and logs)?' + #13#10#13#10 +
                    'Choose No to keep it for a future install.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  if not Purge then Exit;
  // A database or model file can stay locked for a moment after its process exits.
  for Attempt := 1 to 15 do
  begin
    DelTree(DataDir, True, True, True);
    if not DirExists(DataDir) then Exit;
    Sleep(1000);
  end;
end;
