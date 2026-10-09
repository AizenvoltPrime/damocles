# ---------------------------------------------------------------------------------------------
#   Copyright (c) Microsoft Corporation. All rights reserved.
#   Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Damocles: adapted from VS Code's shellIntegration-rc.zsh; every OSC 633 sequence ends with the terminal's nonce, which
# .zshenv read.
builtin autoload -Uz add-zsh-hook

# Prevent the script recursing when setting up
if [ -n "$DAMOCLES_SHELL_INTEGRATION" ]; then
	ZDOTDIR=$DAMOCLES_USER_ZDOTDIR
	builtin return
fi

# This variable allows the shell to both detect that Damocles' shell integration is enabled as well
# as disable it by unsetting the variable.
DAMOCLES_SHELL_INTEGRATION=1

# By default, zsh will set the $HISTFILE to the $ZDOTDIR location automatically. In the case of the
# shell integration being injected, this means that the terminal will use a different history file
# to other terminals. To fix this issue, set $HISTFILE back to the default location before ~/.zshrc
# is called as that may depend upon the value.
if [[  "$DAMOCLES_INJECTION" == "1" ]]; then
	HISTFILE=$DAMOCLES_USER_ZDOTDIR/.zsh_history
fi

# Only fix up ZDOTDIR if shell integration was injected (not manually installed) and has not been called yet
if [[ "$DAMOCLES_INJECTION" == "1" ]]; then
	if [[ $options[norcs] = off  && -f $DAMOCLES_USER_ZDOTDIR/.zshrc ]]; then
		DAMOCLES_ZDOTDIR=$ZDOTDIR
		ZDOTDIR=$DAMOCLES_USER_ZDOTDIR
		# A user's custom HISTFILE location might be set when their .zshrc file is sourced below
		. $DAMOCLES_USER_ZDOTDIR/.zshrc
	fi
fi
builtin unset DAMOCLES_INJECTION

# Shell integration was disabled by the shell, or no nonce arrived: exit without warning.
if [ -z "$DAMOCLES_SHELL_INTEGRATION" ] || [ -z "${__damocles_nonce-}" ]; then
	ZDOTDIR=$DAMOCLES_USER_ZDOTDIR
	builtin return
fi

# The property (P) and command (E) codes embed values which require escaping: backslashes are doubled, and semicolons and
# every control character become \xAB, so a value can never end its sequence early.
__damocles_escape_value() {
	builtin emulate -L zsh

	# Process text byte by byte, not by codepoint.
	builtin local LC_ALL=C str="$1" i byte token out='' val

	for (( i = 0; i < ${#str}; ++i )); do
		byte="${str:$i:1}"
		val=$(( #byte ))
		if (( val < 32 || val == 127 )); then
			token=$(builtin printf '\\x%02x' "$val")
		elif [ "$byte" = "\\" ]; then
			token="\\\\"
		elif [ "$byte" = ";" ]; then
			token="\\x3b"
		else
			token="$byte"
		fi

		out+="$token"
	done

	builtin print -r -- "$out"
}

__damocles_in_command_execution="1"
__damocles_current_command=""

__damocles_prompt_start() {
	builtin printf '\e]633;A;%s\a' "$__damocles_nonce"
}

__damocles_prompt_end() {
	builtin printf '\e]633;B;%s\a' "$__damocles_nonce"
}

__damocles_update_cwd() {
	builtin printf '\e]633;P;Cwd=%s;%s\a' "$(__damocles_escape_value "${PWD}")" "$__damocles_nonce"
}

__damocles_command_output_start() {
	builtin printf '\e]633;E;%s;%s\a' "$(__damocles_escape_value "${__damocles_current_command}")" "$__damocles_nonce"
	builtin printf '\e]633;C;%s\a' "$__damocles_nonce"
}

__damocles_command_complete() {
	if [[ "$__damocles_current_command" == "" ]]; then
		builtin printf '\e]633;D;;%s\a' "$__damocles_nonce"
	else
		builtin printf '\e]633;D;%s;%s\a' "$__damocles_status" "$__damocles_nonce"
	fi
	__damocles_update_cwd
}

__damocles_update_prompt() {
	__damocles_prior_prompt="$PS1"
	__damocles_in_command_execution=""
	PS1="%{$(__damocles_prompt_start)%}$PS1%{$(__damocles_prompt_end)%}"
}

__damocles_precmd() {
	builtin local __damocles_status="$?"
	if [ -z "${__damocles_in_command_execution-}" ]; then
		# not in command execution
		__damocles_command_output_start
	fi

	__damocles_command_complete "$__damocles_status"
	__damocles_current_command=""

	# in command execution
	if [ -n "$__damocles_in_command_execution" ]; then
		# non null
		__damocles_update_prompt
	fi
}

__damocles_preexec() {
	PS1="$__damocles_prior_prompt"
	__damocles_in_command_execution="1"
	__damocles_current_command=$1
	__damocles_command_output_start
}
add-zsh-hook precmd __damocles_precmd
add-zsh-hook preexec __damocles_preexec

if [[ $options[login] = off && $DAMOCLES_USER_ZDOTDIR != $DAMOCLES_ZDOTDIR ]]; then
	ZDOTDIR=$DAMOCLES_USER_ZDOTDIR
fi
