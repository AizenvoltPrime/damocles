# ---------------------------------------------------------------------------------------------
#   Copyright (c) Microsoft Corporation. All rights reserved.
#   Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Damocles: adapted from VS Code's shellIntegration-env.zsh; the first file zsh reads takes the nonce out of the environment.

if [[ -n "${DAMOCLES_NONCE-}" ]]; then
	__damocles_nonce="$DAMOCLES_NONCE"
	builtin unset DAMOCLES_NONCE
fi

if [[ -f $DAMOCLES_USER_ZDOTDIR/.zshenv ]]; then
	DAMOCLES_ZDOTDIR=$ZDOTDIR
	ZDOTDIR=$DAMOCLES_USER_ZDOTDIR

	# prevent recursion
	if [[ $DAMOCLES_USER_ZDOTDIR != $DAMOCLES_ZDOTDIR ]]; then
		. $DAMOCLES_USER_ZDOTDIR/.zshenv
	fi

	DAMOCLES_USER_ZDOTDIR=$ZDOTDIR
	ZDOTDIR=$DAMOCLES_ZDOTDIR
fi
