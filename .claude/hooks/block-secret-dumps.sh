#!/usr/bin/env bash
# PreToolUse(Bash) guard: refuse commands whose only effect is to print
# credentials into the session transcript.
#
# Context: ~/.config/coffeeflow/secrets.env is auto-exported into every shell
# started inside this repo (scripts/install-secrets.sh), so the assistant never
# has to be handed a secret. The flip side is that one careless `env` or
# `cat .env` would write every credential into the transcript permanently —
# where it survives export, sharing and scrollback. This blocks that class of
# command instead of relying on discipline.
#
# Using a secret is always fine:  curl -H "Authorization: Bearer $TOKEN" ...
# Writing one to a file is fine:  printf '%s' "$KEY" > /tmp/k   (redirect present)
# Only *displaying* one is blocked.
#
# The command is split on ; && || | first, and each segment judged on its own,
# so a credential-shaped word elsewhere in a long chain does not trip it.
#
# Exit 0 = allow, exit 2 = block (stderr is shown to the assistant).

set -uo pipefail

CMD=$(python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    print("")
' 2>/dev/null) || exit 0

[[ -z "$CMD" ]] && exit 0

SENSITIVE='[A-Za-z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL|DB_URL)[A-Za-z0-9_]*'
VIEWER='(cat|bat|head|tail|less|more|nl|strings|xxd|od|awk|sed|grep|rg|open|code|pbcopy)'
ENVFILE='(secrets\.env|\.env\.local|\.env\.production|\.icount\.env|/\.env|[[:space:]]\.env)'

deny() {
  echo "BLOCKED by .claude/hooks/block-secret-dumps.sh: $1" >&2
  echo "" >&2
  echo "Secrets are loaded into this shell so they never have to be pasted into" >&2
  echo "chat — printing one would undo that by writing it into the transcript." >&2
  echo "Instead: use the variable inline (curl -H \"Authorization: Bearer \$TOK\")," >&2
  echo "or run ./scripts/secrets-doctor.sh to see what is set without values." >&2
  exit 2
}

# Split the command into segments on ; && || | and judge each independently.
SEGMENTS=$(printf '%s' "$CMD" | python3 -c '
import re, sys
for part in re.split(r"(?:\|\||&&|[;|&\n])", sys.stdin.read()):
    part = part.strip()
    if part:
        print(part)
')

while IFS= read -r seg; do
  [[ -z "$seg" ]] && continue

  # 1. whole-environment dumps
  if [[ "$seg" =~ ^(env|printenv)[[:space:]]*$ ]]; then
    deny "dumps the whole environment"
  fi
  if [[ "$seg" =~ ^printenv[[:space:]]+$SENSITIVE ]]; then
    deny "prints a credential variable"
  fi
  if [[ "$seg" =~ ^(set|export|declare|typeset)([[:space:]]+-p)?[[:space:]]*$ ]]; then
    deny "dumps all shell variables"
  fi

  # 2. reading a secret file with a viewer — verb and path in the SAME segment,
  #    and the path is not a committed template or a .md doc
  if [[ "$seg" =~ (^|[[:space:]])$VIEWER([[:space:]]|$) ]] \
     && [[ "$seg" =~ $ENVFILE ]] \
     && [[ ! "$seg" =~ \.env\.example ]] \
     && [[ ! "$seg" =~ \.md([[:space:]]|$) ]]; then
    deny "reads a secret file"
  fi

  # 3. echoing a credential to the terminal (a redirect to a file is allowed)
  if [[ "$seg" =~ ^(echo|printf)[^\>]*\$\{?$SENSITIVE ]] && [[ ! "$seg" =~ \> ]]; then
    deny "echoes a credential value"
  fi

  # 4. an ad-hoc call to the Vault reader, whose response body IS the secrets.
  #    scripts/bootstrap-from-db.sh is the supported path — it pipes the body
  #    into eval and never lets it reach stdout.
  if [[ "$seg" =~ (ops_get_secrets|decrypted_secrets|vault\.secrets) ]] \
     && [[ ! "$seg" =~ (bootstrap-from-db|secrets-doctor|ops_list_secret_names) ]] \
     && [[ ! "$seg" =~ \.(sql|md)([[:space:]]|$) ]]; then
    deny "would print decrypted Vault secrets — use '. scripts/bootstrap-from-db.sh' instead"
  fi
done <<< "$SEGMENTS"

exit 0
