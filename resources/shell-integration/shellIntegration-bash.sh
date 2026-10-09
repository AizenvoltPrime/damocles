# ---------------------------------------------------------------------------------------------
#   Copyright (c) Microsoft Corporation. All rights reserved.
#   Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Damocles: adapted from VS Code's shellIntegration-bash.sh; every OSC 633 sequence ends with the terminal's nonce.

# Prevent the script recursing when setting up
if [[ -n "${DAMOCLES_SHELL_INTEGRATION:-}" ]]; then
	builtin return
fi

DAMOCLES_SHELL_INTEGRATION=1

# Read the nonce and take it out of the environment before any rc file runs, so no child process inherits it
__damocles_nonce="${DAMOCLES_NONCE:-}"
builtin unset DAMOCLES_NONCE

# Run relevant rc/profile only if shell integration has been injected, not when run manually
if [ "${DAMOCLES_INJECTION:-}" == "1" ]; then
	if [ -z "${DAMOCLES_SHELL_LOGIN:-}" ]; then
		if [ -r ~/.bashrc ]; then
			. ~/.bashrc
		fi
	else
		# Imitate -l because --init-file doesn't support it:
		# run the first of these files that exists
		if [ -r /etc/profile ]; then
			. /etc/profile
		fi
		# execute the first that exists
		if [ -r ~/.bash_profile ]; then
			. ~/.bash_profile
		elif [ -r ~/.bash_login ]; then
			. ~/.bash_login
		elif [ -r ~/.profile ]; then
			. ~/.profile
		fi
		builtin unset DAMOCLES_SHELL_LOGIN
	fi
	builtin unset DAMOCLES_INJECTION
fi

if [ -z "${DAMOCLES_SHELL_INTEGRATION:-}" ] || [ -z "$__damocles_nonce" ]; then
	builtin return
fi

__damocles_get_trap() {
	# 'trap -p DEBUG' outputs a shell command like `trap -- '…shellcode…' DEBUG`.
	# The terms are quoted literals, but are not guaranteed to be on a single line.
	# To parse, we splice those terms into an expression capturing them into an array.
	# This preserves the quoting of those terms: when we `eval` that expression, they are preserved exactly.
	builtin local -a terms
	builtin eval "terms=( $(trap -p "${1:-DEBUG}") )"
	builtin printf '%s' "${terms[2]:-}"
}

# The control characters 0x01-0x1f and 0x7f with their \xAB escapes; bash strings cannot hold 0x00.
__damocles_control_chars=()
__damocles_control_escapes=()
for (( __damocles_i=1; __damocles_i < 32; ++__damocles_i )); do
	builtin printf -v __damocles_hex '%02x' "$__damocles_i"
	builtin printf -v __damocles_char "\\x$__damocles_hex"
	__damocles_control_chars+=("$__damocles_char")
	__damocles_control_escapes+=("\\x$__damocles_hex")
done
__damocles_control_chars+=($'\x7f')
__damocles_control_escapes+=('\x7f')
builtin unset __damocles_i __damocles_hex __damocles_char

# The property (P) and command (E) codes embed values which require escaping: backslashes are doubled, and semicolons and
# every control character become \xAB, so a value can never end its sequence early.
__damocles_escape_value() {
	builtin local LC_ALL=C out i
	out=${1//\\/\\\\}
	out=${out//;/\\x3b}
	for i in "${!__damocles_control_chars[@]}"; do
		out=${out//"${__damocles_control_chars[$i]}"/${__damocles_control_escapes[$i]}}
	done
	builtin printf '%s\n' "$out"
}

# Report the working directory as a Windows path in Git Bash
__damocles_regex_environment="^CYGWIN*|MINGW*|MSYS*"
if [[ "$(uname -s)" =~ $__damocles_regex_environment ]]; then
	__damocles_is_windows=1
else
	__damocles_is_windows=0
fi

# Allow verifying $BASH_COMMAND doesn't have aliases resolved via history when the right HISTCONTROL
# configuration is used
__damocles_regex_histcontrol=".*(erasedups|ignoreboth|ignoredups|ignorespace).*"
if [[ "${HISTCONTROL:-}" =~ $__damocles_regex_histcontrol ]]; then
	__damocles_history_verify=0
else
	__damocles_history_verify=1
fi

builtin unset __damocles_regex_environment
builtin unset __damocles_regex_histcontrol

__damocles_initialized=0
__damocles_original_PS1="$PS1"
__damocles_custom_PS1=""
__damocles_in_command_execution="1"
__damocles_current_command=""

__damocles_prompt_start() {
	builtin printf '\e]633;A;%s\a' "$__damocles_nonce"
}

__damocles_prompt_end() {
	builtin printf '\e]633;B;%s\a' "$__damocles_nonce"
}

__damocles_update_cwd() {
	if [ "$__damocles_is_windows" = "1" ]; then
		__damocles_cwd="$(cygpath -m "$PWD")"
	else
		__damocles_cwd="$PWD"
	fi
	builtin printf '\e]633;P;Cwd=%s;%s\a' "$(__damocles_escape_value "$__damocles_cwd")" "$__damocles_nonce"
}

__damocles_command_output_start() {
	if [[ -z "${__damocles_first_prompt-}" ]]; then
		builtin return
	fi
	builtin printf '\e]633;E;%s;%s\a' "$(__damocles_escape_value "${__damocles_current_command}")" "$__damocles_nonce"
	builtin printf '\e]633;C;%s\a' "$__damocles_nonce"
}

__damocles_command_complete() {
	if [[ -z "${__damocles_first_prompt-}" ]]; then
		__damocles_update_cwd
		builtin return
	fi
	if [ "$__damocles_current_command" = "" ]; then
		builtin printf '\e]633;D;;%s\a' "$__damocles_nonce"
	else
		builtin printf '\e]633;D;%s;%s\a' "$__damocles_status" "$__damocles_nonce"
	fi
	__damocles_update_cwd
}

__damocles_update_prompt() {
	# in command execution
	if [ "$__damocles_in_command_execution" = "1" ]; then
		# Wrap the prompt if it is not yet wrapped, if the PS1 changed this this was last set it
		# means the user re-exported the PS1 so we should re-wrap it
		if [[ "$__damocles_custom_PS1" == "" || "$__damocles_custom_PS1" != "$PS1" ]]; then
			__damocles_original_PS1=$PS1
			__damocles_custom_PS1="\[$(__damocles_prompt_start)\]$__damocles_original_PS1\[$(__damocles_prompt_end)\]"
			PS1="$__damocles_custom_PS1"
		fi
		__damocles_in_command_execution="0"
	fi
}

__damocles_precmd() {
	__damocles_command_complete "$__damocles_status"
	__damocles_current_command=""
	__damocles_first_prompt=1
	__damocles_update_prompt
}

__damocles_preexec() {
	__damocles_initialized=1
	if [[ ! $BASH_COMMAND == __damocles_prompt* ]]; then
		# Use history if it's available to verify the command as BASH_COMMAND comes in with aliases
		# resolved
		if [ "$__damocles_history_verify" = "1" ]; then
			__damocles_current_command="$(builtin history 1 | sed 's/ *[0-9]* *//')"
		else
			__damocles_current_command=$BASH_COMMAND
		fi
	else
		__damocles_current_command=""
	fi
	__damocles_command_output_start
}

# Debug trapping/preexec inspired by starship (ISC)
if [[ -n "${bash_preexec_imported:-}" ]]; then
	__damocles_preexec_only() {
		if [ "$__damocles_in_command_execution" = "0" ]; then
			__damocles_in_command_execution="1"
			__damocles_preexec
		fi
	}
	precmd_functions+=(__damocles_prompt_cmd)
	preexec_functions+=(__damocles_preexec_only)
else
	__damocles_dbg_trap="$(__damocles_get_trap DEBUG)"

	if [[ -z "$__damocles_dbg_trap" ]]; then
		__damocles_preexec_only() {
			if [ "$__damocles_in_command_execution" = "0" ]; then
				__damocles_in_command_execution="1"
				__damocles_preexec
			fi
		}
		trap '__damocles_preexec_only "$_"' DEBUG
	elif [[ "$__damocles_dbg_trap" != '__damocles_preexec "$_"' && "$__damocles_dbg_trap" != '__damocles_preexec_all "$_"' ]]; then
		__damocles_preexec_all() {
			if [ "$__damocles_in_command_execution" = "0" ]; then
				__damocles_in_command_execution="1"
				__damocles_preexec
				builtin eval "${__damocles_dbg_trap}"
			fi
		}
		trap '__damocles_preexec_all "$_"' DEBUG
	fi
fi

__damocles_update_prompt

__damocles_restore_exit_code() {
	return "$1"
}

__damocles_prompt_cmd_original() {
	__damocles_status="$?"
	builtin local cmd
	__damocles_restore_exit_code "${__damocles_status}"
	# Evaluate the original PROMPT_COMMAND similarly to how bash would normally
	# See https://unix.stackexchange.com/a/672843 for technique
	for cmd in "${__damocles_original_prompt_command[@]}"; do
		eval "${cmd:-}"
	done
	__damocles_precmd
}

__damocles_prompt_cmd() {
	__damocles_status="$?"
	__damocles_precmd
}

# PROMPT_COMMAND arrays and strings seem to be handled the same (handling only the first entry of
# the array?)
__damocles_original_prompt_command=${PROMPT_COMMAND:-}

if [[ -z "${bash_preexec_imported:-}" ]]; then
	if [[ -n "${__damocles_original_prompt_command:-}" && "${__damocles_original_prompt_command:-}" != "__damocles_prompt_cmd" ]]; then
		PROMPT_COMMAND=__damocles_prompt_cmd_original
	else
		PROMPT_COMMAND=__damocles_prompt_cmd
	fi
fi
