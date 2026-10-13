; AgencyOS for Windows - Inno Setup script.
;
; Build (see installer/windows/build.ps1 and .github/workflows/windows-installer.yml):
;   ISCC.exe /DAppVersion=1.0.0 /DStageDir=C:\stage /DOutDir=C:\out /DIconFile=C:\icon.ico agencyos.iss
;
; Installs for the current user only (no administrator rights, no UAC prompt). The program goes
; to %LOCALAPPDATA%\Programs\AgencyOS. On a first install the wizard asks where to keep the
; person's data (database, uploads, logs) and, optionally, the local AI models; the default is
; %LOCALAPPDATA%\AgencyOS. The choice is written to %LOCALAPPDATA%\AgencyOS\locations.json, which
; AgencyOS itself reads and later updates when the person moves their data from the status page.
; An upgrade never touches the data and never asks again. For silent installs:
;   /DATADIR=D:\AgencyOS /AIDIR=E:\AgencyOS-AI   (plain letters, numbers and symbols only)

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
AppPublisher=NextGen OS
AppCopyright=Copyright (C) NextGen OS
AppComments=AgencyOS, created by NextGen OS: the advertising agency platform that runs on this computer
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
VersionInfoCompany=NextGen OS
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start {#AppName} in the background when I &sign in to Windows, so scheduled campaigns keep going"; GroupDescription: "Background operation:"
Name: "prepare"; Description: "Download the local AI engine and install &Antigravity now, so they work right away (needs the internet, about 1.5 GB)"; GroupDescription: "Get ready to work:"
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
var
  LocationsPage: TInputDirWizardPage;
  Upgrading: Boolean;

function DefaultDataDir(): String;
begin
  Result := ExpandConstant('{localappdata}\AgencyOS');
end;

function PointerFile(): String;
begin
  Result := DefaultDataDir() + '\locations.json';
end;

function IsPlainAscii(const S: String): Boolean;
var
  I: Integer;
begin
  Result := True;
  for I := 1 to Length(S) do
    if Ord(S[I]) > 126 then
    begin
      Result := False;
      Exit;
    end;
end;

// Reads one folder from locations.json, the file AgencyOS writes. Empty when it is not set.
function ReadPointerFolder(const Key: String): String;
var
  Lines: TArrayOfString;
  I, P, Q: Integer;
  Line: String;
  Found: Boolean;
begin
  Result := '';
  if not LoadStringsFromFile(PointerFile(), Lines) then Exit;
  Found := False;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    if (not Found) and (Pos('"' + Key + '"', Lines[I]) > 0) then
    begin
      Found := True;
      Line := Copy(Lines[I], Pos('"' + Key + '"', Lines[I]) + Length(Key) + 2, Length(Lines[I]));
      P := Pos('"', Line);
      if P > 0 then
      begin
        Line := Copy(Line, P + 1, Length(Line));
        Q := Pos('"', Line);
        if Q > 0 then
        begin
          Result := Copy(Line, 1, Q - 1);
          StringChangeEx(Result, '\\', '\', True);
        end;
      end;
    end;
  end;
end;

// A person who already has AgencyOS data (an upgrade, or a reinstall that kept the data) is never
// asked again: moving data is done from inside AgencyOS, which copies and checks it first.
function IsExistingInstall(): Boolean;
begin
  Result := FileExists(PointerFile()) or FileExists(DefaultDataDir() + '\config\secrets.json');
end;

function IsFolderEmpty(const Dir: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := True;
  if not DirExists(Dir) then Exit;
  if FindFirst(Dir + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          Result := False;
          Exit;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function IsInside(const Child, Parent: String): Boolean;
begin
  Result := Pos(Lowercase(Parent) + '\', Lowercase(Child) + '\') = 1;
end;

// Empty when the folder is fine, otherwise a sentence the person can act on.
function FolderProblem(const Dir, What: String): String;
var
  FreeMB, TotalMB: Cardinal;
begin
  Result := '';
  if Dir = '' then Exit;
  if not IsPlainAscii(Dir) then
    Result := 'The ' + What + ' folder can use only plain letters, numbers and common symbols here. After setup, AgencyOS can move it to any folder (Settings, System).'
  else if Length(Dir) < 3 then
    Result := 'Please enter a full folder path on a drive of this computer, for example D:\AgencyOS.'
  else if (Dir[2] <> ':') or (Dir[3] <> '\') then
    Result := 'Please enter a full folder path on a drive of this computer, for example D:\AgencyOS.'
  else if Length(Dir) = 3 then
    Result := 'Please choose a folder, not a whole drive. For example D:\AgencyOS.'
  else if IsInside(Dir, ExpandConstant('{app}')) then
    Result := 'The ' + What + ' folder cannot be inside the AgencyOS program folder, which is replaced when AgencyOS is updated.'
  else if (not IsFolderEmpty(Dir)) and (not FileExists(Dir + '\config\secrets.json')) then
    Result := 'The ' + What + ' folder already has files in it. Please choose an empty folder or a new one.'
  else if GetSpaceOnDisk(ExtractFileDrive(Dir) + '\', True, FreeMB, TotalMB) and (FreeMB < 1024) then
    Result := 'There is less than 1 GB free on that drive. Please choose a drive with more space.';
end;

function AiFolderProblem(const DataDir, AiDir: String): String;
begin
  Result := FolderProblem(AiDir, 'AI models');
  if (Result = '') and (AiDir <> '') and IsInside(AiDir, DataDir) then
    Result := 'The AI models folder must be outside your data folder, or left as it is to keep them inside it.';
end;

function ChosenDataDir(): String;
begin
  Result := Trim(ExpandConstant('{param:DATADIR|}'));
  if Result = '' then Result := Trim(LocationsPage.Values[0]);
  if Result = '' then Result := DefaultDataDir();
end;

// The AI box is never empty (Setup checks every box on a folder page as a full path), so it starts
// out holding the default place inside the data folder. That value, and the same place under whatever
// data folder was chosen, both mean "keep the AI files with my data"; anything else is a folder of its own.
function AiFromPage(const DataDir, Raw: String): String;
begin
  Result := Trim(Raw);
  if (CompareText(Result, DefaultDataDir() + '\ollama') = 0) or (CompareText(Result, DataDir + '\ollama') = 0) then
    Result := '';
end;

function ChosenAiDir(): String;
var
  Raw: String;
begin
  Raw := Trim(ExpandConstant('{param:AIDIR|}'));
  if Raw = '' then Raw := LocationsPage.Values[1];
  Result := AiFromPage(ChosenDataDir(), Raw);
end;

function JsonPath(const P: String): String;
begin
  Result := P;
  StringChangeEx(Result, '\', '\\', True);
end;

// Only choices that differ from the defaults are stored, exactly as AgencyOS itself writes them.
procedure WritePointer(const DataDir, AiDir: String);
var
  Json: String;
begin
  Json := '{' + #13#10 + '  "version": 1';
  if CompareText(DataDir, DefaultDataDir()) <> 0 then
    Json := Json + ',' + #13#10 + '  "dataRoot": "' + JsonPath(DataDir) + '"';
  if (AiDir <> '') and (CompareText(AiDir, DataDir + '\ollama') <> 0) then
    Json := Json + ',' + #13#10 + '  "aiRoot": "' + JsonPath(AiDir) + '"';
  Json := Json + #13#10 + '}' + #13#10;
  ForceDirectories(DefaultDataDir());
  SaveStringToFile(PointerFile(), Json, False);
end;

procedure InitializeWizard();
begin
  Upgrading := IsExistingInstall();
  LocationsPage := CreateInputDirPage(wpSelectDir,
    'Where should AgencyOS keep your files?',
    'Your database, uploads and logs are stored in a data folder.',
    'Choose a folder on a drive with plenty of free space. Your data stays there when AgencyOS is updated, and you can move it later in AgencyOS under Settings, System.',
    False, '');
  LocationsPage.Add('Data folder (database, uploads, logs):');
  LocationsPage.Add('Local AI models folder (optional; models can take several GB). The default keeps them inside your data folder:');
  LocationsPage.Values[0] := DefaultDataDir();
  LocationsPage.Values[1] := DefaultDataDir() + '\ollama';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if LocationsPage <> nil then
    Result := Upgrading and (PageID = LocationsPage.ID);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
begin
  Result := True;
  // Silent installs never show the page; their folders are checked in PrepareToInstall.
  if WizardSilent then Exit;
  if LocationsPage = nil then Exit;
  if CurPageID <> LocationsPage.ID then Exit;
  Problem := FolderProblem(Trim(LocationsPage.Values[0]), 'data');
  if Problem = '' then Problem := AiFolderProblem(Trim(LocationsPage.Values[0]), AiFromPage(Trim(LocationsPage.Values[0]), LocationsPage.Values[1]));
  if Problem <> '' then
  begin
    MsgBox(Problem, mbError, MB_OK);
    Result := False;
  end;
end;

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
  Result := '';
  // Silent installs (/DATADIR, /AIDIR) never see the wizard page, so check the folders here too.
  if not Upgrading then
  begin
    Result := FolderProblem(ChosenDataDir(), 'data');
    if Result = '' then Result := AiFolderProblem(ChosenDataDir(), ChosenAiDir());
    if Result <> '' then Exit;
  end;
  StopRunningAgencyOS();
end;

// Downloads what a brand-new computer needs before AgencyOS can use its AI (the local AI engine, which is
// the same checked download AgencyOS would make on its first start, and Antigravity, which Google's own
// installer sets up). It never fails the installation: anything it could not get is offered again in
// AgencyOS under Settings, and the result is in the setup log and in the AgencyOS logs folder.
procedure PrepareThisComputer();
var
  Code: Integer;
  Node, Script: String;
begin
  Node := ExpandConstant('{app}\runtime\node\node.exe');
  Script := ExpandConstant('{app}\launcher\agencyos.mjs');
  if not (FileExists(Node) and FileExists(Script)) then
  begin
    Log('Preparing this computer was skipped: the AgencyOS launcher is not in place.');
    Exit;
  end;
  WizardForm.StatusLabel.Caption := 'Downloading the local AI engine and installing Antigravity. This can take several minutes...';
  WizardForm.FilenameLabel.Caption := 'Needs the internet. If it cannot finish, AgencyOS offers it again in Settings.';
  if Exec(Node, '"' + Script + '" prepare', '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Log('Preparing this computer finished with code ' + IntToStr(Code))
  else
    Log('Preparing this computer could not be started: ' + SysErrorMessage(Code));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and (not Upgrading) then
  begin
    ForceDirectories(ChosenDataDir());
    if ChosenAiDir() <> '' then ForceDirectories(ChosenAiDir());
    WritePointer(ChosenDataDir(), ChosenAiDir());
  end;
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('prepare') then
    PrepareThisComputer();
end;

procedure PurgeFolder(const Dir: String);
var
  Attempt: Integer;
begin
  if (Length(Dir) < 4) or (not DirExists(Dir)) then Exit;
  // A database or model file can stay locked for a moment after its process exits.
  for Attempt := 1 to 15 do
  begin
    DelTree(Dir, True, True, True);
    if not DirExists(Dir) then Exit;
    Sleep(1000);
  end;
end;

// The uninstaller keeps the person's data unless they ask for it to go (silent: /PURGEDATA=1).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir, AiDir, Listing: String;
  Purge: Boolean;
begin
  // Make sure nothing is still running (and holding files open) before anything is removed.
  if CurUninstallStep = usUninstall then StopRunningAgencyOS();
  if CurUninstallStep <> usPostUninstall then Exit;
  DataDir := ReadPointerFolder('dataRoot');
  AiDir := ReadPointerFolder('aiRoot');
  if (DataDir <> '') and (not DirExists(DataDir)) then DataDir := '';
  if (AiDir <> '') and (not DirExists(AiDir)) then AiDir := '';
  if (not DirExists(DefaultDataDir())) and (DataDir = '') and (AiDir = '') then Exit;
  Listing := DefaultDataDir();
  if DataDir <> '' then Listing := Listing + #13#10 + DataDir;
  if AiDir <> '' then Listing := Listing + #13#10 + AiDir;
  if UninstallSilent then
    Purge := ExpandConstant('{param:PURGEDATA|0}') = '1'
  else
    Purge := MsgBox('Also delete your AgencyOS data (database, uploads, downloaded AI models and logs)?' + #13#10#13#10 +
                    'These folders and everything in them would be deleted:' + #13#10 + Listing + #13#10#13#10 +
                    'Choose No to keep it for a future install.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  if not Purge then Exit;
  PurgeFolder(DataDir);
  PurgeFolder(AiDir);
  // The default folder goes last because it holds locations.json, which says where the rest was.
  PurgeFolder(DefaultDataDir());
end;
