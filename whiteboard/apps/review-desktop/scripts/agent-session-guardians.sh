# shellcheck shell=bash
# Shared exact resource list for build, cross-platform handoff, and packaged-app gates.

AGENT_SESSION_GUARDIAN_PATHS=(
  "vs/workspace/electron-main/agentSessions/pty/agentPtyGuardian.mjs"
  "vs/workspace/electron-main/agentSessions/agentCliProbeGuardian.mjs"
)

require_agent_session_guardians() {
  local output_root="$1"
  local context="$2"
  local relative_path
  for relative_path in "${AGENT_SESSION_GUARDIAN_PATHS[@]}"; do
    if [[ ! -s "$output_root/$relative_path" ]]; then
      echo "$context is missing required agent session guardian: $output_root/$relative_path" >&2
      return 1
    fi
  done
}
