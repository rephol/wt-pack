# WP-120: CLAUDE_ENV_FILE for agent panes (agents.sh spawn). Claude Code sources it before every Bash command, so
# the pkill/pgrep/killall shims stay first on PATH whatever the shell rc files prepend.
d=${WT_KILL_SHIM_DIR:-}
[ -n "$d" ] && [ -d "$d" ] && case "$PATH" in "$d":*) ;; *) PATH="$d:$PATH"; export PATH ;; esac
