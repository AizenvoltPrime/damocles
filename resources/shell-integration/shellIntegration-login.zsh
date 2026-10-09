# ---------------------------------------------------------------------------------------------
#   Copyright (c) Microsoft Corporation. All rights reserved.
#   Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Damocles: adapted from VS Code's shellIntegration-login.zsh.

# Prevent recursive sourcing
if [[ -n "$DAMOCLES_LOGIN_INITIALIZED" ]]; then
	return
fi
export DAMOCLES_LOGIN_INITIALIZED=1

ZDOTDIR=$DAMOCLES_USER_ZDOTDIR
if [[ $options[norcs] = off && -o "login" &&  -f $ZDOTDIR/.zlogin ]]; then
	. $ZDOTDIR/.zlogin
fi
