// The POSIX stage 0 every transport starts on its target: /bin/sh reads the length line, then exactly that many bytes, and
// evaluates them; it holds no single quote and carries no user data.
export const POSIX_STAGE0_SCRIPT = 'IFS= read -r n; s=$(dd bs=1 count="$n" 2>/dev/null); eval "$s"';
