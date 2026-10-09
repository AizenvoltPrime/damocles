# ---------------------------------------------------------------------------------------------
#   Copyright (c) Microsoft Corporation. All rights reserved.
#   Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Damocles: adapted from VS Code's shellIntegration.ps1; every OSC 633 sequence ends with the terminal's nonce.

# Prevent installing more than once per session
if ((Test-Path variable:global:__DamoclesState) -and $null -ne $Global:__DamoclesState.OriginalPrompt) {
	return;
}

# Disable shell integration when the language mode is restricted
if ($ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
	return;
}

$Global:__DamoclesState = @{
	OriginalPrompt = $function:Prompt
	LastHistoryId = -1
	IsInExecution = $false
	Nonce = $null
	HasPSReadLine = $false
}

# Store the nonce in a regular variable and unset the environment variable. It's by design that
# anything that can execute PowerShell code can read the nonce, as it's basically impossible to hide
# in PowerShell. The most important thing is getting it out of the environment.
$Global:__DamoclesState.Nonce = $env:DAMOCLES_NONCE
$env:DAMOCLES_NONCE = $null
$env:DAMOCLES_INJECTION = $null
$env:DAMOCLES_SHELL_INTEGRATION_SCRIPT = $null

if (-not $Global:__DamoclesState.Nonce) {
	return;
}

# Backslashes are doubled, and semicolons and every control character become \xAB, so a value can never end its
# sequence early.
function Global:__Damocles-Escape-Value([string]$value) {
	[regex]::Replace($value, "[$([char]0x00)-$([char]0x1f)$([char]0x7f)\\;]", { param($match)
			# Encode the (ascii) matches as `\x<hex>`
			-Join (
				[System.Text.Encoding]::UTF8.GetBytes($match.Value) | ForEach-Object { '\x{0:x2}' -f $_ }
			)
		})
}

function Global:__Damocles-Sequence([string]$body) {
	"$([char]0x1b)]633;$body;$($Global:__DamoclesState.Nonce)`a"
}

function Global:Prompt() {
	$FakeCode = [int]!$global:?
	# NOTE: We disable strict mode for the scope of this function because it unhelpfully throws an
	# error when $LastHistoryEntry is null, and is not otherwise useful.
	Set-StrictMode -Off
	$LastHistoryEntry = Get-History -Count 1
	$Result = ""
	# Skip finishing the command if the first command has not yet started or an execution has not
	# yet begun
	if ($Global:__DamoclesState.LastHistoryId -ne -1 -and ($Global:__DamoclesState.HasPSReadLine -eq $false -or $Global:__DamoclesState.IsInExecution -eq $true)) {
		$Global:__DamoclesState.IsInExecution = $false
		if ($LastHistoryEntry.Id -eq $Global:__DamoclesState.LastHistoryId) {
			# Don't provide a command line or exit code if there was no history entry (eg. ctrl+c, enter on no command)
			$Result += __Damocles-Sequence "D;"
		}
		else {
			# Command finished exit code
			# OSC 633 ; D ; <ExitCode> ; <Nonce> ST
			$Result += __Damocles-Sequence "D;$FakeCode"
		}
	}
	# Prompt started
	# OSC 633 ; A ; <Nonce> ST
	$Result += __Damocles-Sequence "A"
	# Current working directory
	# OSC 633 ; P ; Cwd=<Value> ; <Nonce> ST
	if ($pwd.Provider.Name -eq 'FileSystem') {
		$Result += __Damocles-Sequence "P;Cwd=$(__Damocles-Escape-Value $pwd.ProviderPath)"
	}

	# Before running the original prompt, put $? back to what it was:
	if ($FakeCode -ne 0) {
		Write-Error "failure" -ea ignore
	}
	# Run the original prompt
	$Result += $Global:__DamoclesState.OriginalPrompt.Invoke()

	# Write command started
	$Result += __Damocles-Sequence "B"
	$Global:__DamoclesState.LastHistoryId = $LastHistoryEntry.Id
	return $Result
}

# Only send the command executed sequence when PSReadLine is loaded, if not shell integration should
# still work thanks to the command line sequence
if (Get-Module -Name PSReadLine) {
	$Global:__DamoclesState.HasPSReadLine = $true

	$Global:__DamoclesState.OriginalPSConsoleHostReadLine = $function:PSConsoleHostReadLine
	function Global:PSConsoleHostReadLine {
		$CommandLine = $Global:__DamoclesState.OriginalPSConsoleHostReadLine.Invoke()
		$Global:__DamoclesState.IsInExecution = $true

		# Command line
		# OSC 633 ; E ; <CommandLine> ; <Nonce> ST
		$Result = __Damocles-Sequence "E;$(__Damocles-Escape-Value $CommandLine)"

		# Command executed
		# OSC 633 ; C ; <Nonce> ST
		$Result += __Damocles-Sequence "C"

		# Write command executed sequence directly to Console to avoid the new line from Write-Host
		[Console]::Write($Result)

		$CommandLine
	}
}
