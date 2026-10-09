# ---------------------------------------------------------------------------------------------
#   Copyright (c) Microsoft Corporation. All rights reserved.
#   Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Damocles: adapted from VS Code's shellIntegration.fish; every OSC 633 sequence ends with the terminal's nonce.

# Don't run in scripts, without a nonce, or more than once per session.
status is-interactive
and set --query DAMOCLES_NONCE
and ! set --query DAMOCLES_SHELL_INTEGRATION
or exit

set --global DAMOCLES_SHELL_INTEGRATION 1
set --global __damocles_nonce $DAMOCLES_NONCE
set --erase DAMOCLES_NONCE
set --erase DAMOCLES_INJECTION
set --erase DAMOCLES_SHELL_INTEGRATION_SCRIPT

# Tracks if the shell has been initialized
set --global damocles_initialized 0

# Helper function
function __damocles_esc -d "Emit escape sequences for Damocles shell integration"
	builtin printf "\e]633;%s\a" (string join ";" -- $argv $__damocles_nonce)
end

# Escape a value for use in the 'P' ("Property") or 'E' ("Command Line") sequences: backslashes are doubled, and
# semicolons and every control character become \xAB, so a value can never end its sequence early.
set --global __damocles_control_chars \x01 \x02 \x03 \x04 \x05 \x06 \x07 \x08 \x09 \x0a \x0b \x0c \x0d \x0e \x0f \x10 \x11 \x12 \x13 \x14 \x15 \x16 \x17 \x18 \x19 \x1a \x1b \x1c \x1d \x1e \x1f \x7f
set --global __damocles_control_escapes '\\x01' '\\x02' '\\x03' '\\x04' '\\x05' '\\x06' '\\x07' '\\x08' '\\x09' '\\x0a' '\\x0b' '\\x0c' '\\x0d' '\\x0e' '\\x0f' '\\x10' '\\x11' '\\x12' '\\x13' '\\x14' '\\x15' '\\x16' '\\x17' '\\x18' '\\x19' '\\x1a' '\\x1b' '\\x1c' '\\x1d' '\\x1e' '\\x1f' '\\x7f'
function __damocles_escape_value
	set --local out (string replace --all -- '\\' '\\\\' "$argv" | string replace --all -- ';' '\\x3b' | string collect)
	for i in (seq (count $__damocles_control_chars))
		set out (string replace --all -- $__damocles_control_chars[$i] $__damocles_control_escapes[$i] "$out" | string collect)
	end
	echo -n "$out"
end

# Sent right before executing an interactive command.
# Marks the beginning of command output.
function __damocles_cmd_executed --on-event fish_preexec
	# a variable keeps an empty command line as one empty field
	set --local command_line (__damocles_escape_value "$argv")
	__damocles_esc E "$command_line"
	__damocles_esc C

	# Creates a marker to indicate a command was run.
	set --global _damocles_has_cmd
end

# Sent right after an interactive command has finished executing.
# Marks the end of command output.
function __damocles_cmd_finished --on-event fish_postexec
	__damocles_esc D $status
end

# Sent when a command line is cleared or reset, but no command was run.
# Marks the cleared line with neither success nor failure.
function __damocles_cmd_clear --on-event fish_cancel
	if test $damocles_initialized -eq 0
		return
	end
	__damocles_esc E ""
	__damocles_esc C
	__damocles_esc D ""
end

# Preserve the user's existing prompt, to wrap in our escape sequences.
function __damocles_preserve_fish_prompt --on-event fish_prompt
	if functions --query fish_prompt
		if functions --query __damocles_fish_prompt
			# Erase the fallback so it can be set to the user's prompt
			functions --erase __damocles_fish_prompt
		end
		functions --copy fish_prompt __damocles_fish_prompt
		functions --erase __damocles_preserve_fish_prompt
		# Now __damocles_fish_prompt is guaranteed to be defined
		__damocles_init_shell_integration
	else
		if functions --query __damocles_fish_prompt
			functions --erase __damocles_preserve_fish_prompt
			__damocles_init_shell_integration
		else
			# There is no fish_prompt set, so stick with the default
			# Now __damocles_fish_prompt is guaranteed to be defined
			function __damocles_fish_prompt
				echo -n (whoami)@(prompt_hostname) (prompt_pwd) '~> '
			end
		end
	end
end

# Sent whenever a new fish prompt is about to be displayed.
# Updates the current working directory.
function __damocles_update_cwd --on-event fish_prompt
	set --local cwd (__damocles_escape_value "$PWD")
	__damocles_esc P "Cwd=$cwd"

	# If a command marker exists, remove it.
	# Otherwise, the commandline is empty and no command was run.
	if set --query _damocles_has_cmd
		set --erase _damocles_has_cmd
	else
		__damocles_cmd_clear
	end
end

# Sent at the start of the prompt.
# Marks the beginning of the prompt (and, implicitly, a new line).
function __damocles_fish_prompt_start
	__damocles_esc A
	set --global damocles_initialized 1
end

# Sent at the end of the prompt.
# Marks the beginning of the user's command input.
function __damocles_fish_cmd_start
	__damocles_esc B
end

function __damocles_fish_has_mode_prompt -d "Returns true if fish_mode_prompt is defined and not empty"
	functions fish_mode_prompt | string match -rvq '^ *(#|function |end$|$)'
end

# Preserve and wrap fish_mode_prompt (which appears to the left of the regular
# prompt), but only if it's not defined as an empty function (which is the
# officially documented way to disable that feature).
function __damocles_init_shell_integration
	if __damocles_fish_has_mode_prompt
		functions --copy fish_mode_prompt __damocles_fish_mode_prompt

		function fish_mode_prompt
			__damocles_fish_prompt_start
			__damocles_fish_mode_prompt
		end

		function fish_prompt
			__damocles_fish_prompt
			__damocles_fish_cmd_start
		end
	else
		# No fish_mode_prompt, so put everything in fish_prompt.
		function fish_prompt
			__damocles_fish_prompt_start
			__damocles_fish_prompt
			__damocles_fish_cmd_start
		end
	end
end

__damocles_preserve_fish_prompt
