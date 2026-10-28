// Stage 0 is the remote command ssh runs: fixed text carrying no user data, which reads an exact-length stage 1 from stdin
// without reading ahead, so the protocol can take stdin over once stage 1 hands it on.

// The login shell runs this line (sh, bash, zsh, csh or fish), so it holds nothing but one single-quoted argument.
export const POSIX_STAGE0 = `/bin/sh -c 'IFS= read -r n; s=$(dd bs=1 count="$n" 2>/dev/null); eval "$s"'`;

// Win32-OpenSSH gives a session's command overlapped pipes, on which [Console]::OpenStandardInput()'s synchronous ReadFile
// loses bytes, so stdin and stdout open as unbuffered FileStreams in the handle's own mode (FileModeInformation, as .NET 6+
// reads SafeFileHandle.IsAsync). ~ stands for the double quote the C# needs.
const STDIO_SOURCE = [
  'using System;using System.IO;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;',
  'public static class DamoclesStdio{',
  '[DllImport(~kernel32.dll~)]static extern IntPtr GetStdHandle(int which);',
  '[DllImport(~ntdll.dll~)]static extern int NtQueryInformationFile(IntPtr handle,IntPtr[] status,out int mode,int length,int infoClass);',
  'public static Stream Open(int which,FileAccess access){',
  'IntPtr handle=GetStdHandle(which);int mode;',
  'int status=NtQueryInformationFile(handle,new IntPtr[2],out mode,4,16);',
  'if(status!=0)throw new IOException(~reading the mode of standard handle ~+which+~ failed: NTSTATUS ~+status);',
  // FILE_SYNCHRONOUS_IO_ALERT or _NONALERT: a synchronous handle
  'return new FileStream(new SafeFileHandle(handle,false),access,1,(mode&0x30)==0);}}',
].join('');

/** The PowerShell statements that open $DamoclesIn and $DamoclesOut, which stage 1 reads and writes through. */
export const WINDOWS_STDIO_SETUP: readonly string[] = [
  `Add-Type -TypeDefinition ('${STDIO_SOURCE}'.Replace('~',[string][char]34))`,
  '$DamoclesIn=[DamoclesStdio]::Open(-10,[IO.FileAccess]::Read)',
  '$DamoclesOut=[DamoclesStdio]::Open(-11,[IO.FileAccess]::Write)',
];

// One line with no double quote, since Win32-OpenSSH hands a PowerShell default shell the command inside double quotes.
// Stage 1 runs dot-sourced, so it reads and writes through $DamoclesIn and $DamoclesOut, which never re-encode.
export const WINDOWS_STAGE0_SCRIPT: string = [
  '$ErrorActionPreference=\'Stop\'',
  '$ProgressPreference=\'SilentlyContinue\'',
  ...WINDOWS_STDIO_SETUP,
  '$l=New-Object System.IO.MemoryStream',
  'while($true){$c=$DamoclesIn.ReadByte();if($c -lt 0){exit 3};if($c -eq 10){break};$l.WriteByte([byte]$c)}',
  '$n=[int][Text.Encoding]::ASCII.GetString($l.ToArray())',
  '$s=New-Object byte[] $n',
  '$r=0',
  'while($r -lt $n){$k=$DamoclesIn.Read($s,$r,$n-$r);if($k -le 0){exit 3};$r+=$k}',
  '. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($s)))',
].join(';');

/** Under cmd (or a POSIX default shell) PowerShell gets the script encoded; under PowerShell the script is the command itself. */
export function windowsStage0(shell: 'cmd' | 'powershell'): string {
  if (shell === 'powershell') return WINDOWS_STAGE0_SCRIPT;
  const encoded = Buffer.from(WINDOWS_STAGE0_SCRIPT, 'utf16le').toString('base64');
  return `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

/** What the app writes to ssh's stdin first: stage 1's byte length on a line, then its UTF-8 bytes. */
export function stage1Frame(stage1: string): Buffer {
  const body = Buffer.from(stage1, 'utf8');
  return Buffer.concat([Buffer.from(`${body.length}\n`, 'ascii'), body]);
}
