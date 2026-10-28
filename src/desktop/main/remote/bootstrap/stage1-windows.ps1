# Stage 1 on a Windows target: the prerequisite probe, the install, and then the bridge itself. Stage 0 runs it dot-sourced
# with $DamoclesIn and $DamoclesOut, the raw console streams; nothing may reach PowerShell's own output, which would re-encode
# bytes as text, so tool output goes to stderr and only Send-DamoclesLine writes to stdout until the bridge copies bytes.
# Everything above "BEGIN MAIN" only defines; the tests dot-source that part and call the functions.
# BEGIN PARAMETERS
$D_VERSION = ''
$D_INSTALL_FOLDER = ''
$D_PREVIOUS_KIND = 'none'
$D_PREVIOUS_FOLDER = ''
$D_WIN32_X64 = ''
$D_WIN32_ARM64 = ''
# END PARAMETERS

$NEEDED_BUILD = 17763
$NEEDED_MB = 300
$LOCK_STALE_OTHER_HOST_MIN = 30
$STAGING_STALE_MIN = 1440
$LIVE_PID_FILE_MIN = 1500
$LOCK_WAIT_S = 600
# the count curl --retry gets in stage1-posix.sh
$DOWNLOAD_RETRIES = 3
$ATTACH_DEADLINE_MS = 30000
$AUTH_TIMEOUT_MS = 10000
$HANDSHAKE_MAX_BYTES = 65536
$PIPE_PATTERN = '^\\\\\.\\pipe\\(damocles-server-[0-9a-f]{32})$'
$RUN_FOLDER_LABEL = 'damocles-server-run-folder'

# The stage loads only the running PowerShell's own modules: a PSModulePath inherited from the other edition (Windows
# PowerShell 5.1 under PowerShell 7's) names modules it cannot load, Get-FileHash's among them. The daemon gets the inherited one.
$DamoclesInheritedModulePath = $env:PSModulePath
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')

# GetFinalPathNameByHandle, which GetFullPath is not: it expands 8.3 names and follows junctions and links.
$FINAL_PATH_SOURCE = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace Damocles {
  public static class FinalPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    // no access, every share mode, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS (which opens a folder)
    public static string Of(string path) {
      using (SafeFileHandle handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        StringBuilder buffer = new StringBuilder(1024);
        uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length >= buffer.Capacity) {
          buffer = new StringBuilder((int)length + 1);
          length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        }
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        string final = buffer.ToString();
        if (final.StartsWith(@"\\?\UNC\")) return @"\\" + final.Substring(8);
        if (final.StartsWith(@"\\?\")) return final.Substring(4);
        return final;
      }
    }
  }
}
'@

function Send-DamoclesLine([string]$json) {
  $bytes = [Text.Encoding]::UTF8.GetBytes("@@DAMOCLES $json`n")
  $DamoclesOut.Write($bytes, 0, $bytes.Length)
  $DamoclesOut.Flush()
}

function Write-DamoclesLog([string]$line) {
  [Console]::Error.WriteLine($line)
}

function Send-DamoclesFail([string]$code, [hashtable]$params = @{}) {
  Send-DamoclesLine (ConvertTo-Json -Compress -InputObject @{ kind = 'fail'; code = $code; params = $params })
  exit 1
}

function Send-DamoclesNotice([string]$code, [hashtable]$params = @{}) {
  Send-DamoclesLine (ConvertTo-Json -Compress -InputObject @{ kind = 'notice'; code = $code; params = $params })
}

function Send-DamoclesStep([string]$step) {
  Send-DamoclesLine (ConvertTo-Json -Compress -InputObject @{ kind = 'step'; step = $step })
}

# One argument as CommandLineToArgvW and the C runtime read it back.
function ConvertTo-DamoclesArgument([string]$arg) {
  if ($arg -ne '' -and $arg -notmatch '[\s"]') { return $arg }
  $escaped = [regex]::Replace($arg, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

# Runs a tool with both outputs copied to stderr, so neither reaches PowerShell's output; returns its exit code.
function Invoke-DamoclesTool([string]$file, [string[]]$arguments, [string]$cwd = '') {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $file
  $info.Arguments = (($arguments | ForEach-Object { ConvertTo-DamoclesArgument $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  # stdin is the app's protocol channel, never a tool's
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  if ($cwd -ne '') { $info.WorkingDirectory = $cwd }
  $process = [Diagnostics.Process]::Start($info)
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  [Console]::Error.Write($stdout.Result)
  [Console]::Error.Write($stderr.Result)
  return $process.ExitCode
}

function Test-DamoclesWindowsBuild([int]$build) {
  if ($build -lt $NEEDED_BUILD) { Send-DamoclesFail 'windowsBuildTooOld' @{ found = [string]$build; needed = [string]$NEEDED_BUILD } }
}

function Get-DamoclesArch([string]$machine) {
  switch ($machine) {
    'AMD64' { return 'x64' }
    'ARM64' { return 'arm64' }
    default { Send-DamoclesFail 'unsupportedOs' @{ os = 'Windows'; arch = $machine } }
  }
}

function Get-DamoclesFreeMb([string]$folder) {
  $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($folder))
  return [int64][Math]::Floor((New-Object IO.DriveInfo $root).AvailableFreeSpace / 1MB)
}

function Test-DamoclesSpace([string]$folder) {
  $mb = Get-DamoclesFreeMb $folder
  if ($mb -lt $NEEDED_MB) { Send-DamoclesFail 'lowSpace' @{ folder = $folder; freeMb = $mb; neededMb = $NEEDED_MB } }
}

# The Git Bash the agent's Bash tool would run, where Git for Windows installs it or in an absolute PATH folder; WSL's
# System32\bash.exe is not Git Bash.
function Find-DamoclesGitBash([string[]]$programFolders, [string]$pathValue) {
  foreach ($root in $programFolders) {
    if ($root -and [IO.Path]::IsPathRooted($root)) {
      $candidate = Join-Path $root 'Git\bin\bash.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  foreach ($folder in ($pathValue -split ';')) {
    if ($folder -and [IO.Path]::IsPathRooted($folder) -and $folder -notmatch '\\System32\\?$') {
      $candidate = Join-Path $folder 'bash.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  return $null
}

function Test-DamoclesGitBash([string[]]$programFolders, [string]$pathValue) {
  if ($null -eq (Find-DamoclesGitBash $programFolders $pathValue)) { Send-DamoclesNotice 'noGitBash' }
}

# The PSModulePath the stage inherited as a NAME=value entry, none when it inherited none.
function Get-DamoclesInheritedModulePathEntry {
  if ($null -eq $DamoclesInheritedModulePath) { return @() }
  return @("PSModulePath=$DamoclesInheritedModulePath")
}

# Starts a command line outside the ssh session's job object; $null when WMI refuses it (policy or a blocked service).
function Start-DamoclesWmi([string]$commandLine, [string]$cwd) {
  try {
    $environment = [string[]](@(Get-ChildItem Env: | Where-Object { $_.Name -ne 'PSModulePath' } | ForEach-Object { "$($_.Name)=$($_.Value)" }) + @(Get-DamoclesInheritedModulePathEntry))
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $environment; ShowWindow = [uint16]0 }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $cwd; ProcessStartupInformation = $startup }
  } catch {
    Write-DamoclesLog "[stage1] WMI process creation failed: $($_.Exception.Message)"
    return $null
  }
  if ($result.ReturnValue -ne 0) {
    Write-DamoclesLog "[stage1] Win32_Process.Create answered $($result.ReturnValue)"
    return $null
  }
  return $result.ProcessId
}

function Test-DamoclesWmi {
  $cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
  if ($null -eq (Start-DamoclesWmi "$(ConvertTo-DamoclesArgument $cmd) /d /c exit 0" $env:SystemRoot)) { Send-DamoclesNotice 'wmiBlocked' }
}

function Expand-DamoclesHome([string]$folder) {
  if ($folder -eq '~') { return $env:USERPROFILE }
  if ($folder.StartsWith('~/') -or $folder.StartsWith('~\')) { return (Join-Path $env:USERPROFILE $folder.Substring(2)) }
  return $folder
}

function Get-DamoclesInstallDir([string]$folder, [string]$user) {
  if ($folder -ne '') { return (Join-Path (Expand-DamoclesHome $folder) $user) }
  return (Join-Path $env:USERPROFILE '.damocles\server')
}

# A path as one spelling for comparisons: the final path of one that exists (8.3 names expanded, junctions and links
# followed), else the absolute path; backslashes, no trailing separator.
function Get-DamoclesFinalPath([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  if (-not (Test-Path -LiteralPath $full)) { return $full.TrimEnd('\', '/') }
  if (-not ('Damocles.FinalPath' -as [type])) { Add-Type -TypeDefinition $FINAL_PATH_SOURCE }
  return [Damocles.FinalPath]::Of($full).TrimEnd('\', '/')
}

function Get-DamoclesUserSid {
  return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

# Whether only this user, SYSTEM, Administrators and TrustedInstaller may change $folder or, through inheritance, what is
# made in it; CREATOR OWNER's grant goes to whoever could already create there.
function Test-DamoclesFolderPrivate([string]$folder) {
  $trusted = @((Get-DamoclesUserSid), 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  # write data, append data, write extended attributes, delete child, write attributes, delete, write DAC, write owner,
  # generic all and generic write
  $writeMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
  $acl = New-Object Security.AccessControl.DirectorySecurity($folder, [Security.AccessControl.AccessControlSections]'Access, Owner')
  if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $trusted -contains $rule.IdentityReference.Value) { continue }
    if (([int]$rule.FileSystemRights -band $writeMask) -ne 0) { return $false }
  }
  return $true
}

# Creates a missing <install> granting only this user and SYSTEM, as the run folder grants only the user, since a folder
# inherits its parent's ACL (a drive root's lets every signed-in user modify what is made in it); refuses an existing one in a
# configured folder others may change. The default lives in the user's profile, whose ACL is the user's.
function Initialize-DamoclesInstall([string]$install, [bool]$configured) {
  if (Test-Path -LiteralPath $install -PathType Container) {
    if ($configured -and -not (Test-DamoclesFolderPrivate $install)) { Send-DamoclesFail 'installFolderUnsafe' @{ folder = $install } }
  } else {
    try {
      [void][IO.Directory]::CreateDirectory($install)
    } catch {
      Send-DamoclesFail 'noexec' @{ folder = $install; reason = 'notWritable' }
    }
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    # /reset drops the explicit entries first: a folder whose parent hands nothing down holds the creating token's default DACL
    if ((Invoke-DamoclesTool $icacls @($install, '/reset')) -ne 0 -or (Invoke-DamoclesTool $icacls @($install, '/inheritance:r', '/grant:r', "*$(Get-DamoclesUserSid):(OI)(CI)F", '*S-1-5-18:(OI)(CI)F')) -ne 0) {
      Send-DamoclesFail 'installFolderUnsafe' @{ folder = $install }
    }
  }
  Test-DamoclesSpace $install
}

function Test-DamoclesPidAlive([int]$processId) {
  return $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)
}

# install.lock is a directory whose owner file names `<host> <pid>`: stale when that pid is gone on this host, or after
# LOCK_STALE_OTHER_HOST_MIN minutes when another host took it.
function Test-DamoclesLockStale([string]$lock) {
  $ownerFile = Join-Path $lock 'owner'
  $owner = ''
  # a stage releasing the lock may remove the file between any check and the read
  try { $owner = ([IO.File]::ReadAllText($ownerFile)).Trim() } catch { $owner = '' }
  $parts = $owner -split ' '
  if ($owner -ne '' -and $parts.Count -eq 2 -and $parts[0] -eq [Environment]::MachineName -and $parts[1] -match '^\d+$') {
    return -not (Test-DamoclesPidAlive ([int]$parts[1]))
  }
  $item = Get-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
  return ($null -ne $item) -and ($item.LastWriteTime -lt (Get-Date).AddMinutes(-$LOCK_STALE_OTHER_HOST_MIN))
}

function New-DamoclesDirectory([string]$path) {
  try {
    [void](New-Item -ItemType Directory -Path $path -ErrorAction Stop)
    return $true
  } catch {
    return $false
  }
}

# A stale lock is removed only under the takeover lock, as on POSIX targets.
function Remove-DamoclesStaleLock([string]$lock) {
  $takeover = "$lock.takeover"
  $item = Get-Item -LiteralPath $takeover -Force -ErrorAction SilentlyContinue
  if ($null -ne $item -and $item.LastWriteTime -lt (Get-Date).AddMinutes(-1)) { Remove-Item -LiteralPath $takeover -Force -ErrorAction SilentlyContinue }
  if (-not (New-DamoclesDirectory $takeover)) { return $false }
  if (Test-DamoclesLockStale $lock) { Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $takeover -Force
  return -not (Test-Path -LiteralPath $lock)
}

# Takes the lock at once, taking over a stale one; $false while a live stage holds it.
function Enter-DamoclesLockNow([string]$lock) {
  if (-not (New-DamoclesDirectory $lock)) {
    if (-not ((Test-DamoclesLockStale $lock) -and (Remove-DamoclesStaleLock $lock) -and (New-DamoclesDirectory $lock))) { return $false }
  }
  [IO.File]::WriteAllText((Join-Path $lock 'owner'), "$([Environment]::MachineName) $PID`n")
  return $true
}

function Enter-DamoclesLock([string]$lock) {
  $waited = 0
  while (-not (Enter-DamoclesLockNow $lock)) {
    $waited++
    if ($waited -gt $LOCK_WAIT_S) { Send-DamoclesFail 'unknown' @{ reason = 'installLocked' } }
    Start-Sleep -Seconds 1
  }
}

function Exit-DamoclesLock([string]$lock) {
  Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
}

function Remove-DamoclesOldStaging([string]$install) {
  $cutoff = (Get-Date).AddMinutes(-$STAGING_STALE_MIN)
  Get-ChildItem -LiteralPath $install -Directory -Force -Filter '.staging-*' | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
}

function New-DamoclesStaging([string]$install) {
  $bytes = New-Object byte[] 6
  (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
  $path = Join-Path $install ('.staging-' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))
  [void](New-Item -ItemType Directory -Path $path -ErrorAction Stop)
  return $path
}

function Send-DamoclesProgress([string]$file, [int64]$size) {
  $item = Get-Item -LiteralPath $file -ErrorAction SilentlyContinue
  if ($null -ne $item) { Send-DamoclesLine ('{"progress":' + ([Math]::Min($item.Length, $size) / $size).ToString('0.000', [Globalization.CultureInfo]::InvariantCulture) + '}') }
}

# A failed try's code: http<status> for an HTTP answer, else the WebException status camel-cased, else other.
function Get-DamoclesDownloadFailure([Exception]$exception) {
  while ($null -ne $exception -and $exception -isnot [Net.WebException]) { $exception = $exception.InnerException }
  if ($null -eq $exception) { return 'other' }
  if ($null -ne $exception.Response -and $exception.Response -is [Net.HttpWebResponse]) { return 'http' + [int]$exception.Response.StatusCode }
  $status = [string]$exception.Status
  return $status.Substring(0, 1).ToLowerInvariant() + $status.Substring(1)
}

# One try; $null on success, else the failure's code. WebClient creates the file anew, so no partial bytes are resumed.
function Invoke-DamoclesDownloadTry([string]$url, [string]$file, [int64]$size) {
  $client = New-Object Net.WebClient
  try {
    $task = $client.DownloadFileTaskAsync($url, $file)
    while (-not $task.Wait(1000)) { Send-DamoclesProgress $file $size }
    return $null
  } catch {
    Write-DamoclesLog "[stage1] the download failed: $($_.Exception.Message)"
    return Get-DamoclesDownloadFailure $_.Exception
  } finally {
    $client.Dispose()
  }
}

# curl --retry's policy: up to DOWNLOAD_RETRIES more tries, waiting 1 s and doubling; an HTTP 4xx other than 408 and 429 is
# final. Progress is the staged file's size against the package's, as on POSIX targets.
function Invoke-DamoclesDownload([string]$url, [string]$file, [int64]$size) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $delay = 1
  for ($attempt = 1; ; $attempt++) {
    $failure = Invoke-DamoclesDownloadTry $url $file $size
    if ($null -eq $failure) { return $true }
    Send-DamoclesLine (ConvertTo-Json -Compress -InputObject @{ kind = 'downloadFailed'; attempt = $attempt; reason = $failure })
    if ($attempt -gt $DOWNLOAD_RETRIES -or ($failure -match '^http4\d\d$' -and $failure -ne 'http408' -and $failure -ne 'http429')) { return $false }
    Start-Sleep -Seconds $delay
    $delay *= 2
  }
}

# Reads one line of stdin byte by byte, so nothing past it is consumed.
function Read-DamoclesLine {
  $line = New-Object IO.MemoryStream
  while ($true) {
    $byte = $DamoclesIn.ReadByte()
    if ($byte -lt 0) { return $null }
    if ($byte -eq 10) { break }
    $line.WriteByte([byte]$byte)
  }
  return [Text.Encoding]::ASCII.GetString($line.ToArray())
}

# The app answers an upload request with `<length>\n<bytes>` from its artifact cache; exactly that many bytes are read.
function Receive-DamoclesUpload([string]$file, [int64]$size) {
  Send-DamoclesLine '{"kind":"upload"}'
  $length = Read-DamoclesLine
  if ($length -ne [string]$size) { return $false }
  $out = [IO.File]::Create($file)
  try {
    $buffer = New-Object byte[] 65536
    $left = $size
    while ($left -gt 0) {
      $read = $DamoclesIn.Read($buffer, 0, [int][Math]::Min($buffer.Length, $left))
      if ($read -le 0) { return $false }
      $out.Write($buffer, 0, $read)
      $left -= $read
    }
  } finally {
    $out.Dispose()
  }
  return $true
}

# The version an installed version folder holds: a version-named <version>-<target> folder with the package's
# server-package.json; '' for anything else, which no stage or removal touches. remove-windows.ps1 has the same function.
function Get-DamoclesDirVersion([string]$path) {
  $name = Split-Path -Leaf $path
  if (-not (Test-Path -LiteralPath (Join-Path $path 'server-package.json') -PathType Leaf)) { return '' }
  if ($name -match '^([0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]*)?)-win32-(x64|arm64)$') { return $Matches[1] }
  return ''
}

function Test-DamoclesVersionDir([string]$path) {
  return (Get-DamoclesDirVersion $path) -ne ''
}

# Whether version folder $path holds a complete install: the launcher and the package's manifest.
function Test-DamoclesInstalled([string]$path) {
  return (Test-Path -LiteralPath (Join-Path $path 'node\node.exe') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $path 'server-package.json') -PathType Leaf)
}

function Get-DamoclesPidFiles {
  $server = Join-Path $env:USERPROFILE '.damocles\server'
  if (-not (Test-Path -LiteralPath $server)) { return @() }
  return @(Get-ChildItem -LiteralPath $server -Directory -Force -Filter 'run-*' | ForEach-Object { Join-Path $_.FullName 'daemon.pid' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
}

function Read-DamoclesPidRecord([string]$file) {
  try {
    return ([IO.File]::ReadAllText($file) | ConvertFrom-Json)
  } catch {
    return $null
  }
}

# The versions recently touched pid files name; with $exceptRun (run-<key>), only other machines' (this machine's daemon is
# Test-DamoclesDaemonRunsFrom's).
function Get-DamoclesLiveVersions([string]$exceptRun = '') {
  $cutoff = (Get-Date).AddMinutes(-$LIVE_PID_FILE_MIN)
  return @(Get-DamoclesPidFiles | Where-Object { (Split-Path -Leaf (Split-Path -Parent $_)) -ne $exceptRun -and (Get-Item -LiteralPath $_ -Force).LastWriteTime -ge $cutoff } | ForEach-Object { (Read-DamoclesPidRecord $_).version } | Where-Object { $_ -is [string] })
}

# Keeps the current version, every version a live pid file names, and the newest previous one.
function Invoke-DamoclesPrune([string]$install, [string]$current) {
  $keep = Get-DamoclesLiveVersions
  # by name: a listing spells the folder in full, the setting may not (C:/tools, an 8.3 name)
  $others = @(Get-ChildItem -LiteralPath $install -Directory -Force | Where-Object { (Test-DamoclesVersionDir $_.FullName) -and $_.Name -ne (Split-Path -Leaf $current) } | Sort-Object LastWriteTime -Descending)
  foreach ($dir in ($others | Select-Object -Skip 1)) {
    if ($keep -notcontains (Get-DamoclesDirVersion $dir.FullName)) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force }
  }
}

function Test-DamoclesDaemonRunsFrom([string]$folder) {
  $prefix = "$(Get-DamoclesFinalPath $folder)\"
  foreach ($file in Get-DamoclesPidFiles) {
    $record = Read-DamoclesPidRecord $file
    if ($null -eq $record -or -not ($record.pid -is [int] -or $record.pid -is [int64])) { continue }
    $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($null -ne $process -and $process.Path -and (Get-DamoclesFinalPath $process.Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# Removes Damocles' own entries from the previous <install> under its install lock, never the folder itself, which may be
# shared. Reports settled once nothing of Damocles is left there; a daemon of this machine running from it, a live lock, or a
# version another machine's live pid file names defers that to a later connect.
function Clear-DamoclesPrevious([string]$previous, [string]$install) {
  if (-not (Test-Path -LiteralPath $previous -PathType Container) -or (Get-DamoclesFinalPath $previous) -eq (Get-DamoclesFinalPath $install)) {
    Send-DamoclesLine '{"kind":"settled"}'
    return
  }
  if (Test-DamoclesDaemonRunsFrom $previous) { return }
  $lock = Join-Path $previous 'install.lock'
  if (-not (Enter-DamoclesLockNow $lock)) { return }
  $keep = Get-DamoclesLiveVersions "run-$(Get-DamoclesRunKey)"
  $kept = $false
  foreach ($entry in @(Get-ChildItem -LiteralPath $previous -Force)) {
    $version = Get-DamoclesDirVersion $entry.FullName
    if ($version -ne '') {
      if ($keep -contains $version) { $kept = $true } else { Remove-Item -LiteralPath $entry.FullName -Recurse -Force }
    } elseif ($entry.Name -like '.staging-*') {
      Remove-Item -LiteralPath $entry.FullName -Recurse -Force
    }
  }
  Exit-DamoclesLock $lock
  $takeover = Get-Item -LiteralPath "$lock.takeover" -Force -ErrorAction SilentlyContinue
  if ($null -ne $takeover -and $takeover.LastWriteTime -lt (Get-Date).AddMinutes(-1)) { Remove-Item -LiteralPath $takeover.FullName -Force }
  if (-not $kept) { Send-DamoclesLine '{"kind":"settled"}' }
}

# Ends the install after a failure: the staging folder and the lock go, then the stage fails.
function Stop-DamoclesInstall([string]$staging, [string]$lock, [string]$code, [hashtable]$params = @{}) {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  Exit-DamoclesLock $lock
  Send-DamoclesFail $code $params
}

# Installs the package into $versionDir under the install lock: downloaded or uploaded into a staging folder, its hash
# checked before it is unpacked, its self-test run, then renamed into place.
function Install-DamoclesVersion {
  Enter-DamoclesLock $lock
  if (Test-DamoclesInstalled $versionDir) {
    Exit-DamoclesLock $lock
    return
  }
  Send-DamoclesStep 'installing'
  Remove-DamoclesOldStaging $install
  $staging = New-DamoclesStaging $install
  $archive = Join-Path $staging $packageFile
  if (-not (Invoke-DamoclesDownload $packageUrl $archive $packageSize)) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    if (-not (Receive-DamoclesUpload $archive $packageSize)) { Stop-DamoclesInstall $staging $lock 'downloadAndUploadFailed' }
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $packageSha) { Stop-DamoclesInstall $staging $lock 'hashMismatch' }
  $unpacked = Join-Path $staging 'package'
  [void](New-Item -ItemType Directory -Path $unpacked)
  if ((Invoke-DamoclesTool (Join-Path $env:SystemRoot 'System32\tar.exe') @('-xf', $archive, '-C', $unpacked)) -ne 0) { Stop-DamoclesInstall $staging $lock 'unknown' @{ reason = 'unpackFailed' } }
  Remove-Item -LiteralPath $archive -Force
  if ((Invoke-DamoclesTool (Join-Path $unpacked 'node\node.exe') @((Join-Path $unpacked 'dist\daemon.js'), 'self-test') $unpacked) -ne 0) { Stop-DamoclesInstall $staging $lock 'selfTestFailed' }
  # an incomplete folder of this version, which a failed removal leaves, goes once nothing runs from it
  if (Test-Path -LiteralPath $versionDir) {
    if (Test-DamoclesDaemonRunsFrom $versionDir) { Stop-DamoclesInstall $staging $lock 'unknown' @{ reason = 'versionFolderBusy' } }
    try {
      Remove-Item -LiteralPath $versionDir -Recurse -Force
    } catch {
      Write-DamoclesLog "[stage1] removing the incomplete $versionDir failed: $($_.Exception.Message)"
      Stop-DamoclesInstall $staging $lock 'unknown' @{ reason = 'versionFolderBusy' }
    }
  }
  try {
    [IO.Directory]::Move($unpacked, $versionDir)
  } catch {
    Write-DamoclesLog "[stage1] moving the package into $versionDir failed: $($_.Exception.Message)"
    Stop-DamoclesInstall $staging $lock 'unknown' @{ reason = 'moveFailed' }
  }
  Remove-Item -LiteralPath $staging -Recurse -Force
  Invoke-DamoclesPrune $install $versionDir
  Exit-DamoclesLock $lock
}

function Get-DamoclesRunKey {
  $key = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64).OpenSubKey('SOFTWARE\Microsoft\Cryptography')
  $machineId = ([string]$key.GetValue('MachineGuid')).ToLowerInvariant()
  $hmac = New-Object Security.Cryptography.HMACSHA256 (, [Text.Encoding]::UTF8.GetBytes($machineId))
  $digest = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($RUN_FOLDER_LABEL))
  return ((($digest | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16))
}

function Get-DamoclesHmac([byte[]]$token, [string]$label, [byte[]]$first, [byte[]]$second) {
  $hmac = New-Object Security.Cryptography.HMACSHA256 (, $token)
  $data = New-Object IO.MemoryStream
  $labelBytes = [Text.Encoding]::ASCII.GetBytes($label)
  $data.Write($labelBytes, 0, $labelBytes.Length)
  $data.Write($first, 0, $first.Length)
  $data.Write($second, 0, $second.Length)
  return , $hmac.ComputeHash($data.ToArray())
}

# Compares in time independent of where the bytes differ.
function Test-DamoclesEqual([byte[]]$a, [byte[]]$b) {
  if ($a.Length -ne $b.Length) { return $false }
  $diff = 0
  for ($i = 0; $i -lt $a.Length; $i++) { $diff = $diff -bor ($a[$i] -bxor $b[$i]) }
  return $diff -eq 0
}

# A PersistentProtocol control frame: type 2, id 0, ack 0, the body's length big-endian, then the body.
function New-DamoclesControlFrame([byte[]]$body) {
  $frame = New-Object byte[] (13 + $body.Length)
  $frame[0] = 2
  $frame[9] = [byte](($body.Length -shr 24) -band 0xff)
  $frame[10] = [byte](($body.Length -shr 16) -band 0xff)
  $frame[11] = [byte](($body.Length -shr 8) -band 0xff)
  $frame[12] = [byte]($body.Length -band 0xff)
  [Array]::Copy($body, 0, $frame, 13, $body.Length)
  return , $frame
}

# The codec's object of one or two keys, each a short UTF-8 key and a value: an unsigned integer below 128, or 32 bytes.
function New-DamoclesCodecObject([object[]]$entries) {
  $out = New-Object IO.MemoryStream
  $out.WriteByte(11)
  $out.WriteByte([byte]($entries.Count / 2))
  for ($i = 0; $i -lt $entries.Count; $i += 2) {
    $key = [Text.Encoding]::ASCII.GetBytes([string]$entries[$i])
    $out.WriteByte(7)
    $out.WriteByte([byte]$key.Length)
    $out.Write($key, 0, $key.Length)
    $value = $entries[$i + 1]
    if ($value -is [byte[]]) {
      $out.WriteByte(9)
      $out.WriteByte([byte]$value.Length)
      $out.Write($value, 0, $value.Length)
    } else {
      $out.WriteByte(4)
      $out.WriteByte([byte]$value)
    }
  }
  return , $out.ToArray()
}

# The daemon's challenge answer: exactly an object with the 32-byte nonce and proof, or $null.
function Read-DamoclesChallengeAnswer([byte[]]$body) {
  if ($body.Length -lt 2 -or $body[0] -ne 11 -or $body[1] -ne 2) { return $null }
  $at = 2
  $fields = @{}
  for ($entry = 0; $entry -lt 2; $entry++) {
    if ($at + 2 -gt $body.Length -or $body[$at] -ne 7 -or $body[$at + 1] -gt 8) { return $null }
    $length = $body[$at + 1]
    if ($at + 2 + $length + 2 + 32 -gt $body.Length) { return $null }
    $name = [Text.Encoding]::ASCII.GetString($body, $at + 2, $length)
    $at += 2 + $length
    if ($body[$at] -ne 9 -or $body[$at + 1] -ne 32) { return $null }
    $value = New-Object byte[] 32
    [Array]::Copy($body, $at + 2, $value, 0, 32)
    $fields[$name] = $value
    $at += 34
  }
  if ($at -ne $body.Length -or -not $fields.ContainsKey('nonce') -or -not $fields.ContainsKey('proof')) { return $null }
  return $fields
}

# Reads exactly $count bytes of $stream within the task deadline; $null on an early end or a timeout.
function Read-DamoclesExact([IO.Stream]$stream, [int]$count, [DateTime]$deadline) {
  $buffer = New-Object byte[] $count
  $have = 0
  while ($have -lt $count) {
    $task = $stream.ReadAsync($buffer, $have, $count - $have)
    $left = [int][Math]::Max(0, ($deadline - (Get-Date)).TotalMilliseconds)
    if (-not $task.Wait($left)) { return $null }
    if ($task.Result -le 0) { return $null }
    $have += $task.Result
  }
  return , $buffer
}

# The bridge's side of the mutual authentication: proves the pipe's server holds the token before sending it anything but
# the first nonce, then proves its own. $false means the endpoint is not this user's daemon.
function Invoke-DamoclesHandshake([IO.Pipes.NamedPipeClientStream]$pipe, [byte[]]$token) {
  $bridgeNonce = New-Object byte[] 32
  (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bridgeNonce)
  $hello = New-DamoclesControlFrame (New-DamoclesCodecObject @('v', 1, 'nonce', $bridgeNonce))
  $pipe.Write($hello, 0, $hello.Length)
  $pipe.Flush()
  $deadline = (Get-Date).AddMilliseconds($AUTH_TIMEOUT_MS)
  $header = Read-DamoclesExact $pipe 13 $deadline
  if ($null -eq $header -or $header[0] -ne 2) { return $false }
  $length = ([int64]$header[9] -shl 24) -bor ([int64]$header[10] -shl 16) -bor ([int64]$header[11] -shl 8) -bor [int64]$header[12]
  if ($length -gt $HANDSHAKE_MAX_BYTES) { return $false }
  $body = Read-DamoclesExact $pipe ([int]$length) $deadline
  if ($null -eq $body) { return $false }
  $answer = Read-DamoclesChallengeAnswer $body
  if ($null -eq $answer) { return $false }
  if (-not (Test-DamoclesEqual $answer['proof'] (Get-DamoclesHmac $token 'damocles-daemon' $bridgeNonce $answer['nonce']))) { return $false }
  $proof = New-DamoclesControlFrame (New-DamoclesCodecObject @('proof', (Get-DamoclesHmac $token 'damocles-bridge' $answer['nonce'] $bridgeNonce)))
  $pipe.Write($proof, 0, $proof.Length)
  $pipe.Flush()
  return $true
}

# The daemon the pid file names, authenticated, or $null.
function Connect-DamoclesDaemon([string]$runDir) {
  $record = Read-DamoclesPidRecord (Join-Path $runDir 'daemon.pid')
  if ($null -eq $record -or $null -ne $record.socketFolder -or -not ($record.endpoint -is [string]) -or $record.endpoint -notmatch $PIPE_PATTERN) { return $null }
  $pipeName = $Matches[1]
  $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $pipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
  try {
    $tokenText = ([IO.File]::ReadAllText((Join-Path $runDir 'token'))).Trim()
    if ($tokenText -notmatch '^[0-9a-f]{64}$') { throw 'the token file does not hold a daemon token' }
    $token = New-Object byte[] 32
    for ($i = 0; $i -lt 32; $i++) { $token[$i] = [Convert]::ToByte($tokenText.Substring($i * 2, 2), 16) }
    $pipe.Connect(2000)
    if (Invoke-DamoclesHandshake $pipe $token) { return $pipe }
    Write-DamoclesLog '[stage1] the pipe the pid file names is not this user''s daemon'
  } catch {
    Write-DamoclesLog "[stage1] the daemon did not answer: $($_.Exception.Message)"
  }
  $pipe.Dispose()
  return $null
}

# Starts the daemon through WMI, so it outlives the ssh session; inside the session when WMI refuses.
function Start-DamoclesDaemon([string]$versionDir) {
  $node = Join-Path $versionDir 'node\node.exe'
  $daemon = Join-Path $versionDir 'dist\daemon.js'
  $commandLine = "$(ConvertTo-DamoclesArgument $node) $(ConvertTo-DamoclesArgument $daemon) serve"
  if ($null -ne (Start-DamoclesWmi $commandLine $versionDir)) { return }
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $node
  $info.Arguments = "$(ConvertTo-DamoclesArgument $daemon) serve"
  $info.WorkingDirectory = $versionDir
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.EnvironmentVariables.Remove('PSModulePath')
  if ($null -ne $DamoclesInheritedModulePath) { $info.EnvironmentVariables['PSModulePath'] = $DamoclesInheritedModulePath }
  [void][Diagnostics.Process]::Start($info)
}

# The bridge: the authenticated daemon pipe, started first when none answers, then bytes copied both ways on the raw streams.
function Start-DamoclesBridge([string]$versionDir) {
  $runDir = Join-Path $env:USERPROFILE ".damocles\server\run-$(Get-DamoclesRunKey)"
  $deadline = (Get-Date).AddMilliseconds($ATTACH_DEADLINE_MS)
  $started = $false
  $pipe = $null
  while ($null -eq $pipe) {
    $pipe = Connect-DamoclesDaemon $runDir
    if ($null -ne $pipe) { break }
    if (-not $started) {
      $started = $true
      Start-DamoclesDaemon $versionDir
    }
    if ((Get-Date) -ge $deadline) { Send-DamoclesFail 'bridgeFailed' @{ reason = 'noDaemon' } }
    Start-Sleep -Milliseconds 200
  }
  Send-DamoclesLine '{"kind":"bridge"}'
  $up = $DamoclesIn.CopyToAsync($pipe)
  $down = $pipe.CopyToAsync($DamoclesOut)
  [void][Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($up, $down))
  $pipe.Dispose()
  exit 0
}

# BEGIN MAIN
Send-DamoclesStep 'checking'
$build = [int](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
Test-DamoclesWindowsBuild $build
$machine = $env:PROCESSOR_ARCHITEW6432
if (-not $machine) { $machine = $env:PROCESSOR_ARCHITECTURE }
$arch = Get-DamoclesArch $machine
Test-DamoclesSpace $env:USERPROFILE
Test-DamoclesGitBash @($env:ProgramFiles, ${env:ProgramFiles(x86)}) $env:Path
Test-DamoclesWmi

$target = "win32-$arch"
$package = $D_WIN32_X64
if ($arch -eq 'arm64') { $package = $D_WIN32_ARM64 }
if ($package -eq '') { Send-DamoclesFail 'unknown' @{ reason = 'noPackage'; target = $target } }
# <file> <sha256> <size> <url>, none of which holds a space
$packageFile, $packageSha, $packageSize, $packageUrl = $package -split ' '
$packageSize = [int64]$packageSize

$user = $env:USERNAME
# an empty name would make <folder> itself the install folder
if ([string]::IsNullOrEmpty($user)) { Send-DamoclesFail 'unknown' @{ reason = 'noUserName' } }
$install = Get-DamoclesInstallDir $D_INSTALL_FOLDER $user
Initialize-DamoclesInstall $install ($D_INSTALL_FOLDER -ne '')
Send-DamoclesLine (ConvertTo-Json -Compress -InputObject @{ kind = 'probe'; target = $target; install = $install })

$versionDir = Join-Path $install "$D_VERSION-$target"
$lock = Join-Path $install 'install.lock'
if (-not (Test-DamoclesInstalled $versionDir)) { Install-DamoclesVersion }

if ($D_PREVIOUS_KIND -eq 'default') { Clear-DamoclesPrevious (Get-DamoclesInstallDir '' $user) $install }
if ($D_PREVIOUS_KIND -eq 'folder') { Clear-DamoclesPrevious (Get-DamoclesInstallDir $D_PREVIOUS_FOLDER $user) $install }

Send-DamoclesStep 'starting'
Start-DamoclesBridge $versionDir
