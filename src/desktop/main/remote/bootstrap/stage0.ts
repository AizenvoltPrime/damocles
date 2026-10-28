// Stage 0 is the remote command ssh runs: fixed text carrying no user data, which reads an exact-length stage 1 from stdin
// without reading ahead, so the protocol can take stdin over once stage 1 hands it on.

// The login shell runs this line (sh, bash, zsh, csh or fish), so it holds nothing but one single-quoted argument.
export const POSIX_STAGE0 = `/bin/sh -c 'IFS= read -r n; s=$(dd bs=1 count="$n" 2>/dev/null); eval "$s"'`;

// One line with no double quote, since Win32-OpenSSH hands a PowerShell default shell the command inside double quotes.
// The raw console streams are unbuffered and never re-encode; stage 1 runs dot-sourced, so it reads and writes through them.
export const WINDOWS_STAGE0_SCRIPT: string = [
  '$ErrorActionPreference=\'Stop\'',
  '$ProgressPreference=\'SilentlyContinue\'',
  '$DamoclesIn=[Console]::OpenStandardInput()',
  '$DamoclesOut=[Console]::OpenStandardOutput()',
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
