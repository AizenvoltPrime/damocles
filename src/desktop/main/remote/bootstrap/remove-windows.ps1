# The removal stage on a Windows target, run as stage 0 runs stage 1 once the daemon exited: this machine's run folder, the
# installed versions no other machine's live daemon or terminal host record names and Damocles' own entries in an install
# folder but its security floor (never the folder), leaving a removed marker in each install folder that held a server and in
# the one stage 1 uses, and, only when asked, the key line Damocles installed. Only Send-DamoclesLine writes to stdout
# ($DamoclesOut).
# Everything above "BEGIN MAIN" only defines; the tests dot-source that part and call the functions.
# BEGIN PARAMETERS
$D_RUN_KEY = ''
$D_INSTALL_FOLDER = ''
$D_PREVIOUS_FOLDER = ''
$D_KEY = ''
$D_KEY_FILE = ''
# END PARAMETERS

# a pid file the daemon touched within this long names a live version, as stage 1 reads it
$LIVE_PID_FILE_MIN = 1500
# lock-timing.ts LOCK_STALE_MS: the daemon refreshes its lock's mtime every 5 s, and a lock older than this has no holder
$DAEMON_LOCK_STALE_S = 20
# lock-timing.ts TAKEOVER_STALE_MS: a takeover lock older than this was left by a start that died inside it
$DAEMON_TAKEOVER_STALE_S = 10
$LOCK_STALE_OTHER_HOST_MIN = 30
$STAGING_STALE_MIN = 1440
# an exec test or a marker's temporary file older than this belongs to a stage that died before deleting it
$EXEC_TEST_STALE_MIN = 1
# proper-lockfile's default stale time, which security-floor.ts raiseFloor's lock keeps
$FLOOR_LOCK_STALE_S = 10
# remove-server.ts MAX_PARAM_CHARS (500) holds 40 pids of up to 10 digits and their spaces
$MAX_NAMED_HOSTS = 40

function Send-DamoclesLine([string]$json) {
  $bytes = [Text.Encoding]::UTF8.GetBytes("@@DAMOCLES $json`n")
  $DamoclesOut.Write($bytes, 0, $bytes.Length)
  $DamoclesOut.Flush()
}

function Send-DamoclesFail([string]$code, [hashtable]$params = @{}) {
  Send-DamoclesLine (ConvertTo-Json -Compress -InputObject @{ kind = 'fail'; code = $code; params = $params })
  exit 1
}

function Send-DamoclesNotice([string]$code, [hashtable]$params = @{}) {
  Send-DamoclesLine (ConvertTo-Json -Compress -InputObject @{ kind = 'notice'; code = $code; params = $params })
}

function Expand-DamoclesHome([string]$folder) {
  if ($folder -eq '~') { return $env:USERPROFILE }
  if ($folder.StartsWith('~/') -or $folder.StartsWith('~\')) { return (Join-Path $env:USERPROFILE $folder.Substring(2)) }
  return $folder
}

# Deletes $path, reporting it and carrying on when something of it stays (a locked file, a path past MAX_PATH).
function Remove-DamoclesEntry([string]$path) {
  try {
    Remove-Item -LiteralPath $path -Recurse -Force
  } catch {
    [Console]::Error.WriteLine("[remove] deleting $path failed: $($_.Exception.Message)")
  }
  if (Test-Path -LiteralPath $path) { Send-DamoclesNotice 'deleteFailed' @{ entry = $path } }
}

# The version an installed version folder holds: a version-named <version>-<target> folder with the package's
# server-package.json; '' for anything else, which no stage or removal touches. stage1-windows.ps1 has the same function.
function Get-DamoclesDirVersion([string]$path) {
  $name = Split-Path -Leaf $path
  if (-not (Test-Path -LiteralPath (Join-Path $path 'server-package.json') -PathType Leaf)) { return '' }
  if ($name -match '^([0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]*)?)-win32-(x64|arm64)$') { return $Matches[1] }
  return ''
}

function Read-DamoclesPidRecord([string]$file) {
  try {
    return ([IO.File]::ReadAllText($file) | ConvertFrom-Json)
  } catch {
    return $null
  }
}

# A run folder's daemon pid file and terminal host records <pid>.json, the only names token.ts reads.
function Get-DamoclesPidFiles([string]$runDir) {
  $hosts = Join-Path $runDir 'terminal-hosts'
  return @(@(Join-Path $runDir 'daemon.pid') + @(if (Test-Path -LiteralPath $hosts -PathType Container) { Get-ChildItem -LiteralPath $hosts -File -Force -Filter '*.json' | Where-Object { $_.Name -cmatch '^[1-9][0-9]{0,14}\.json$' } | ForEach-Object { $_.FullName } }) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
}

# Whether the process $id runs as this user, as kill -0 tells on POSIX; $false when WMI cannot say (another user's process
# hides its owner). [wmi] needs no module, so a PSModulePath from the other edition cannot hide it.
function Test-DamoclesOwnProcess([int64]$id) {
  try {
    return ([wmi]"Win32_Process.Handle='$id'").GetOwnerSid().Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  } catch {
    return $false
  }
}

# Whether the live process runs the Node of an installed server package, as every terminal host does; one whose program
# cannot be read counts as one only when it is this user's.
function Test-DamoclesRunsFromInstall($process) {
  if (-not $process.Path) { return (Test-DamoclesOwnProcess $process.Id) }
  return (Get-DamoclesDirVersion (Split-Path -Parent (Split-Path -Parent $process.Path))) -ne ''
}

# @{ version; machine } for each other machine's recently touched pid file, a daemon's or a terminal host's; $runDir is this
# machine's run folder.
function Get-DamoclesOtherLiveRecords([string]$server, [string]$runDir) {
  if (-not (Test-Path -LiteralPath $server -PathType Container)) { return @() }
  $cutoff = (Get-Date).AddMinutes(-$LIVE_PID_FILE_MIN)
  return @(Get-ChildItem -LiteralPath $server -Directory -Force -Filter 'run-*' | Where-Object { $_.FullName -ne $runDir } | ForEach-Object { Get-DamoclesPidFiles $_.FullName } | ForEach-Object {
      if ((Get-Item -LiteralPath $_ -Force).LastWriteTime -ge $cutoff) {
        $record = Read-DamoclesPidRecord $_
        if ($null -ne $record -and $record.version -is [string]) {
          $machine = '?'
          if ($record.hostname -is [string] -and $record.hostname -ne '') { $machine = $record.hostname }
          @{ version = $record.version; machine = $machine }
        }
      }
    })
}

# The live process a pid file's record names; $null when it names none.
function Get-DamoclesRecordProcess([string]$file) {
  $record = Read-DamoclesPidRecord $file
  if ($null -eq $record -or -not ($record.pid -is [int] -or $record.pid -is [int64]) -or $record.pid -le 0) { return $null }
  return Get-Process -Id $record.pid -ErrorAction SilentlyContinue
}

# Whether this machine's daemon still runs: the run folder's pid file names a live process.
function Test-DamoclesOwnDaemonRuns([string]$runDir) {
  $file = Join-Path $runDir 'daemon.pid'
  return (Test-Path -LiteralPath $file -PathType Leaf) -and $null -ne (Get-DamoclesRecordProcess $file)
}

# The pids of this machine's terminal hosts that still run: a record names a live process that runs from an install, so a pid
# another program took since never holds a removal. Nothing here kills one: the daemon ends them, proving each process first.
function Get-DamoclesLiveTerminalHosts([string]$runDir) {
  return @(Get-DamoclesPidFiles $runDir | Where-Object { (Split-Path -Leaf $_) -ne 'daemon.pid' } | ForEach-Object {
      $process = Get-DamoclesRecordProcess $_
      if ($null -ne $process -and (Test-DamoclesRunsFromInstall $process)) { [string]$process.Id }
    })
}

function New-DamoclesDirectory([string]$path) {
  try {
    [void](New-Item -ItemType Directory -Path $path -ErrorAction Stop)
    return $true
  } catch {
    return $false
  }
}

# Takes the daemon lock's takeover lock $takeover as singleton.ts does, waiting while a start holds it; $false when it stays held.
function Enter-DamoclesDaemonTakeover([string]$takeover) {
  $waited = 0
  while (-not (New-DamoclesDirectory $takeover)) {
    $item = Get-Item -LiteralPath $takeover -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and $item.LastWriteTime -lt (Get-Date).AddSeconds(-$DAEMON_TAKEOVER_STALE_S)) {
      Remove-Item -LiteralPath $takeover -Recurse -Force -ErrorAction SilentlyContinue
    } elseif ($waited -ge $DAEMON_TAKEOVER_STALE_S) {
      return $false
    } else {
      Start-Sleep -Seconds 1
      $waited++
    }
  }
  return $true
}

# Whether the daemon lock $lock has no holder: unchanged for DAEMON_LOCK_STALE_S, or its owner file names a process of this
# host that has ended (token.ts goneFromThisHost).
function Test-DamoclesDaemonLockFree([string]$lock) {
  $item = Get-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
  if ($null -ne $item -and $item.LastWriteTime -lt (Get-Date).AddSeconds(-$DAEMON_LOCK_STALE_S)) { return $true }
  $owner = ''
  try { $owner = [IO.File]::ReadAllText("$lock.owner") } catch { $owner = '' }
  if ($owner -notmatch '^(\S+) (\d+)\n$') { return $false }
  return $Matches[1] -eq [Net.Dns]::GetHostName() -and $null -eq (Get-Process -Id ([int]$Matches[2]) -ErrorAction SilentlyContinue)
}

# Takes the daemon's mkdir lock $lock as singleton.ts does, under its takeover lock and with this stage as its owner, so no
# daemon starts while its run folder goes; $false while a daemon holds it.
function Enter-DamoclesDaemonLock([string]$lock) {
  if (-not (Enter-DamoclesDaemonTakeover "$lock.takeover")) { return $false }
  $taken = New-DamoclesDirectory $lock
  if (-not $taken -and (Test-DamoclesDaemonLockFree $lock)) {
    Remove-Item -LiteralPath $lock -Recurse -Force
    $taken = New-DamoclesDirectory $lock
  }
  if ($taken) { [IO.File]::WriteAllText("$lock.owner", "$([Net.Dns]::GetHostName()) $PID`n") }
  Remove-Item -LiteralPath "$lock.takeover" -Force
  return $taken
}

function Exit-DamoclesDaemonLock([string]$lock) {
  Remove-Item -LiteralPath "$lock.owner" -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $lock -Force
}

# The daemon's lock this stage holds, touched as the daemon touches its own, so a starting daemon never takes it as stale.
function Update-DamoclesDaemonLock([string]$lock) {
  [IO.Directory]::SetLastWriteTime($lock, [DateTime]::Now)
}

# Deletes the run folder whose daemon lock this stage holds: every entry but the lock, its owner file and a start's takeover
# lock, the lock touched after each, then the lock, then the folder, which a start's takeover lock keeps.
function Remove-DamoclesRunDir([string]$runDir) {
  $lock = Join-Path $runDir 'daemon.lock'
  foreach ($entry in @(Get-ChildItem -LiteralPath $runDir -Force)) {
    if (@('daemon.lock', 'daemon.lock.owner', 'daemon.lock.takeover') -notcontains $entry.Name) {
      Remove-DamoclesEntry $entry.FullName
      Update-DamoclesDaemonLock $lock
    }
  }
  Remove-DamoclesEntry "$lock.owner"
  Update-DamoclesDaemonLock $lock
  Remove-DamoclesEntry $lock
  if (@(Get-ChildItem -LiteralPath $runDir -Force).Count -eq 0) { Remove-DamoclesEntry $runDir }
}

# install.lock as stage 1 takes it: a directory whose owner file names `<host> <pid>`, stale when that pid is gone on this
# host or after LOCK_STALE_OTHER_HOST_MIN minutes when another host took it, removed only under the takeover lock.
function Test-DamoclesLockStale([string]$lock) {
  $owner = ''
  try { $owner = ([IO.File]::ReadAllText((Join-Path $lock 'owner'))).Trim() } catch { $owner = '' }
  $parts = $owner -split ' '
  if ($owner -ne '' -and $parts.Count -eq 2 -and $parts[0] -eq [Environment]::MachineName -and $parts[1] -match '^\d+$') {
    return $null -eq (Get-Process -Id ([int]$parts[1]) -ErrorAction SilentlyContinue)
  }
  $item = Get-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
  return ($null -ne $item) -and ($item.LastWriteTime -lt (Get-Date).AddMinutes(-$LOCK_STALE_OTHER_HOST_MIN))
}

function Remove-DamoclesStaleLock([string]$lock) {
  $takeover = "$lock.takeover"
  $item = Get-Item -LiteralPath $takeover -Force -ErrorAction SilentlyContinue
  if ($null -ne $item -and $item.LastWriteTime -lt (Get-Date).AddMinutes(-1)) { Remove-Item -LiteralPath $takeover -Force -ErrorAction SilentlyContinue }
  if (-not (New-DamoclesDirectory $takeover)) { return $false }
  if (Test-DamoclesLockStale $lock) { Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $takeover -Force
  return -not (Test-Path -LiteralPath $lock)
}

# Takes the install lock at once, taking over a stale one; $false while a live stage holds it.
function Enter-DamoclesLockNow([string]$lock) {
  if (-not (New-DamoclesDirectory $lock)) {
    if (-not ((Test-DamoclesLockStale $lock) -and (Remove-DamoclesStaleLock $lock) -and (New-DamoclesDirectory $lock))) { return $false }
  }
  [IO.File]::WriteAllText((Join-Path $lock 'owner'), "$([Environment]::MachineName) $PID`n")
  return $true
}

# What a dead raise of $folder's security floor left (security-floor.ts raiseFloor): its temporary files, deleted under its
# proper-lockfile lock taken as proper-lockfile takes it (a stale one taken over), then the lock. The floor itself stays
# (docs/invariants.md, Remove Damocles server); nothing goes while a live raise holds the lock.
function Remove-DamoclesFloorLeftovers([string]$folder) {
  $lock = Join-Path $folder 'security-floor.lock'
  if (-not (New-DamoclesDirectory $lock)) {
    $item = Get-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.LastWriteTime -ge (Get-Date).AddSeconds(-$FLOOR_LOCK_STALE_S)) { return }
    Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (New-DamoclesDirectory $lock)) { return }
  }
  Get-ChildItem -LiteralPath $folder -File -Force | Where-Object { $_.Name -like 'security-floor.*.tmp' } | ForEach-Object { Remove-DamoclesEntry $_.FullName }
  Remove-DamoclesEntry $lock
}

# The marker that keeps an automatic connect from installing in $folder again (stage1-windows.ps1 Install-DamoclesVersion):
# written to a temporary file and renamed, holding the removal's UTC time, under the install folder's ACL, which grants only its
# user and SYSTEM (stage1-windows.ps1 Initialize-DamoclesInstall). Kept, as the floor is.
function Set-DamoclesRemovedMark([string]$folder) {
  $marker = Join-Path $folder 'removed'
  $temp = Join-Path $folder ".removed-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
  try {
    [IO.File]::WriteAllText($temp, [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture) + "`n")
    Move-Item -LiteralPath $temp -Destination $marker -Force
  } catch {
    [Console]::Error.WriteLine("[remove] writing $marker failed: $($_.Exception.Message)")
    if (Test-Path -LiteralPath $temp) { Remove-DamoclesEntry $temp }
    Send-DamoclesNotice 'markerFailed' @{ folder = $folder }
  }
}

# Removes the version folders of $folder that no other live daemon or terminal host record names, the staging folders, the exec
# tests, a dead marker write's and a dead floor raise's leftovers and the lock, under its install lock. First the removed marker
# goes in when $mark is set (the install folder stage 1 uses) or the folder holds a version folder, before the lock, so a stage
# that takes the lock next finds it. Says which of its security floor and marker the folder keeps. A stage installing there
# keeps the folder as it is, and only staging folders too old to be in use go.
function Remove-DamoclesEntries([string]$folder, [object[]]$others, [bool]$mark = $false) {
  if (-not (Test-Path -LiteralPath $folder -PathType Container)) { return }
  $holdsVersions = @(Get-ChildItem -LiteralPath $folder -Directory -Force | Where-Object { (Get-DamoclesDirVersion $_.FullName) -ne '' }).Count -gt 0
  if ($mark -or $holdsVersions) { Set-DamoclesRemovedMark $folder }
  $lock = Join-Path $folder 'install.lock'
  if (-not (Enter-DamoclesLockNow $lock)) {
    Send-DamoclesNotice 'installInProgress' @{ folder = $folder }
    $cutoff = (Get-Date).AddMinutes(-$STAGING_STALE_MIN)
    Get-ChildItem -LiteralPath $folder -Directory -Force -Filter '.staging-*' | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object { Remove-DamoclesEntry $_.FullName }
    return
  }
  foreach ($entry in @(Get-ChildItem -LiteralPath $folder -Force)) {
    $version = Get-DamoclesDirVersion $entry.FullName
    if ($version -ne '') {
      $holder = $others | Where-Object { $_.version -eq $version } | Select-Object -First 1
      if ($null -ne $holder) {
        Send-DamoclesNotice 'versionKept' @{ version = $version; machine = $holder.machine }
        continue
      }
      Remove-DamoclesEntry $entry.FullName
    } elseif ($entry.Name -like '.staging-*' -or (($entry.Name -like '.exec-test-*' -or $entry.Name -like '.removed-*') -and $entry.LastWriteTime -lt (Get-Date).AddMinutes(-$EXEC_TEST_STALE_MIN))) {
      Remove-DamoclesEntry $entry.FullName
    }
  }
  Remove-DamoclesFloorLeftovers $folder
  $floor = Test-Path -LiteralPath (Join-Path $folder 'security-floor') -PathType Leaf
  $marker = Test-Path -LiteralPath (Join-Path $folder 'removed') -PathType Leaf
  if ($floor -or $marker) { Send-DamoclesNotice 'floorKept' @{ folder = $folder; files = $(if ($floor -and $marker) { 'both' } elseif ($floor) { 'floor' } else { 'marker' }) } }
  Remove-DamoclesEntry $lock
  $takeover = Get-Item -LiteralPath "$lock.takeover" -Force -ErrorAction SilentlyContinue
  if ($null -ne $takeover -and $takeover.LastWriteTime -lt (Get-Date).AddMinutes(-1)) { Remove-DamoclesEntry $takeover.FullName }
}

# Drops the lines of $file holding the key (type and blob), writing into the same file so its ACL stays; $true when found. A
# file that cannot be read or rewritten fails with keyFile; the kept lines stay beside it when the rewrite failed.
function Remove-DamoclesKeyLine([string]$file, [string]$key) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  try {
    $lines = @([IO.File]::ReadAllLines($file))
  } catch {
    [Console]::Error.WriteLine("[remove] reading $file failed: $($_.Exception.Message)")
    Send-DamoclesFail 'stageFailed' @{ code = 'keyFile' }
  }
  $kept = @($lines | Where-Object { -not $_.Contains($key) })
  if ($kept.Count -eq $lines.Count) { return $false }
  $text = ''
  if ($kept.Count -gt 0) { $text = ($kept -join "`r`n") + "`r`n" }
  $encoding = New-Object Text.UTF8Encoding $false
  $bytes = New-Object byte[] 4
  (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
  $beside = Join-Path (Split-Path -Parent $file) ('.damocles-keys-' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))
  foreach ($target in @($beside, $file)) {
    try {
      [IO.File]::WriteAllText($target, $text, $encoding)
    } catch {
      [Console]::Error.WriteLine("[remove] writing $target failed: $($_.Exception.Message)")
      Send-DamoclesFail 'stageFailed' @{ code = 'keyFile' }
    }
  }
  Remove-Item -LiteralPath $beside -Force
  return $true
}

function Remove-DamoclesFolderIfEmpty([string]$folder) {
  if ((Test-Path -LiteralPath $folder -PathType Container) -and @(Get-ChildItem -LiteralPath $folder -Force).Count -eq 0) {
    Remove-DamoclesEntry $folder
  }
}

# BEGIN MAIN
$ErrorActionPreference = 'Stop'
if ($D_RUN_KEY -notmatch '^[0-9a-f]{16}$') { Send-DamoclesFail 'stageFailed' @{ code = 'runKey' } }
# an empty name would make <folder> itself the install folder
if ([string]::IsNullOrEmpty($env:USERNAME)) { Send-DamoclesFail 'stageFailed' @{ code = 'userName' } }
$server = Join-Path $env:USERPROFILE '.damocles\server'
$runDir = Join-Path $server "run-$D_RUN_KEY"
if (Test-Path -LiteralPath $runDir -PathType Container) {
  $daemonLock = Join-Path $runDir 'daemon.lock'
  if (-not (Enter-DamoclesDaemonLock $daemonLock)) { Send-DamoclesFail 'daemonRunning' }
  if (Test-DamoclesOwnDaemonRuns $runDir) {
    Exit-DamoclesDaemonLock $daemonLock
    Send-DamoclesFail 'daemonRunning'
  }
  $hostPids = @(Get-DamoclesLiveTerminalHosts $runDir | Select-Object -First $MAX_NAMED_HOSTS)
  if ($hostPids.Count -gt 0) {
    Exit-DamoclesDaemonLock $daemonLock
    Send-DamoclesFail 'terminalHostRunning' @{ pids = ($hostPids -join ' ') }
  }
}
$others = Get-DamoclesOtherLiveRecords $server $runDir

if (Test-Path -LiteralPath $runDir -PathType Container) { Remove-DamoclesRunDir $runDir }
# the install folder stage 1 uses, the configured one else the default, gets the removed marker whether or not it held a server
Remove-DamoclesEntries $server $others ($D_INSTALL_FOLDER -eq '')
foreach ($folder in @($D_INSTALL_FOLDER, $D_PREVIOUS_FOLDER)) {
  if ($folder -ne '') {
    $install = Join-Path (Expand-DamoclesHome $folder) $env:USERNAME
    Remove-DamoclesEntries $install $others ($folder -eq $D_INSTALL_FOLDER)
    # <folder>\<user> goes once empty; <folder> itself always stays
    Remove-DamoclesFolderIfEmpty $install
  }
}
Remove-DamoclesFolderIfEmpty $server
# the security floor's and the marker's own notice says why they stay
if ((Test-Path -LiteralPath $server) -and @(Get-ChildItem -LiteralPath $server -Force | Where-Object { $_.Name -ne 'security-floor' -and $_.Name -ne 'removed' }).Count -gt 0) {
  Send-DamoclesNotice 'serverFolderKept'
}

# only the file the install wrote, which this user could write then
if ($D_KEY -ne '' -and -not (Remove-DamoclesKeyLine $D_KEY_FILE $D_KEY)) { Send-DamoclesNotice 'keyNotFound' }
Send-DamoclesLine '{"kind":"removed"}'
