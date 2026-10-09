# ---------------------------------------------------------------------------------------------
#   Copyright (c) Microsoft Corporation. All rights reserved.
#   Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Damocles: adapted from VS Code's shellIntegration-profile.zsh.

# Prevent recursive sourcing
if [[ -n "$DAMOCLES_PROFILE_INITIALIZED" ]]; then
	return
fi
export DAMOCLES_PROFILE_INITIALIZED=1

if [[ $options[norcs] = off && -o "login" ]]; then
	if [[ -f $DAMOCLES_USER_ZDOTDIR/.zprofile ]]; then
		DAMOCLES_ZDOTDIR=$ZDOTDIR
		ZDOTDIR=$DAMOCLES_USER_ZDOTDIR
		. $DAMOCLES_USER_ZDOTDIR/.zprofile
		ZDOTDIR=$DAMOCLES_ZDOTDIR
	fi
fi
