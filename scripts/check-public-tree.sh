#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "check-public-tree: $*" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
cd "$repo_root"

# The distribution repository is deliberately smaller than the private source
# repository. Reject every tracked path that is not part of its explicit public
# contract, including files later added manually on GitHub.
while IFS= read -r -d '' tracked_file; do
  case "$tracked_file" in
    .env.example | \
    .github/workflows/ci.yml | \
    .gitignore | \
    .opencode/command/* | \
    .opencode/steps/* | \
    NOTICE.md | \
    README.md | \
    package.json | \
    packages/* | \
    pnpm-lock.yaml | \
    pnpm-workspace.yaml | \
    scripts/check-public-tree.sh | \
    tsconfig.base.json | \
    vitest.config.ts)
      ;;
    *)
      fail "tracked path is outside the public allowlist: $tracked_file"
      ;;
  esac

  case "/$tracked_file" in
    */.env | */.env.*)
      [[ "$tracked_file" == ".env.example" ]] || \
        fail "tracked environment file is prohibited: $tracked_file"
      ;;
    *.db | *.db-* | *.sqlite | *.sqlite-* | *.sqlite3 | *.sqlite3-* | \
    *.pem | *.key | *.p12)
      fail "tracked runtime or credential file is prohibited: $tracked_file"
      ;;
  esac
done < <(git ls-files -z)

# This intentionally covers only high-confidence credential shapes. GitHub's
# native secret scanning remains the broader second line of defense.
secret_pattern='(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})'
if git grep -I -n -E -- "$secret_pattern"; then
  fail "high-confidence credential pattern found"
fi

private_identity_pattern='(/Users/[A-Za-z0-9._-]+/|C:\\Users\\[A-Za-z0-9._-]+\\)'
if git grep -I -n -E -- "$private_identity_pattern"; then
  fail "private filesystem path found"
fi

echo "Public tree policy check passed."
