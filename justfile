set shell := ["bash", "-euo", "pipefail", "-c"]

skill_dir := env_var('HOME') / ".claude/skills/archify"
archive_dir := env_var('HOME') / ".claude/skills/.archify-versions"

_default:
    @just --list --unsorted --list-heading '' --list-prefix='- '

derived_subject := "chore: regenerate derived files"
derived_paths := "examples archify/examples docs archify/assets/template.html"

# rebase local work onto upstream and rebuild the derived-files commit
pull:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ fetching upstream"
    git fetch upstream
    # the tip commit only holds regenerated files, so drop and rebuild it instead of merging it
    if [[ "$(git log -1 --format=%s)" == "{{derived_subject}}" ]]; then
        echo "→ dropping the derived-files commit"
        git reset --keep HEAD~1
    fi
    echo "→ rebasing onto upstream/main"
    git rebase --autostash upstream/main
    echo "→ installing dev dependencies"
    npm ci --no-audit --no-fund
    npm --prefix archify ci --no-audit --no-fund
    echo "→ regenerating derived files"
    ARCHIFY_CHROME="${ARCHIFY_CHROME:-/Applications/Chromium.app/Contents/MacOS/Chromium}" node scripts/fork-regenerate.mjs
    git add -u -- {{derived_paths}}
    git commit -q -m "{{derived_subject}}" -m "rebuilt by scripts/fork-regenerate.mjs; drop and regenerate this commit on every upstream sync."
    echo "✓ pull complete; publish with: git push --force-with-lease origin main"

# install dev dependencies
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ installing npm dependencies"
    npm --prefix archify ci
    echo "✓ setup complete"

# run the full test suite
test:
    @npm --prefix archify test

# install the skill into ~/.claude/skills, archiving the current version first
install:
    #!/usr/bin/env bash
    set -euo pipefail
    # the stager packages git-tracked files only, so uncommitted work is skipped
    if [[ -n "$(git status --porcelain -- archify)" ]]; then
        echo "⚠ uncommitted changes under archify/ will NOT be installed"
    fi
    version=$(node -p "require('./archify/package.json').version")
    if [[ -d "{{skill_dir}}" ]]; then
        installed=$(node -p "require('{{skill_dir}}/package.json').version" 2>/dev/null || echo unknown)
        stamp=$(date +%Y%m%d-%H%M%S)
        mkdir -p "{{archive_dir}}"
        echo "→ archiving installed $installed"
        mv "{{skill_dir}}" "{{archive_dir}}/${installed}-${stamp}"
    fi
    echo "→ staging $version"
    node scripts/stage-clean-skill.mjs --root "$(pwd)" --dest "{{skill_dir}}" >/dev/null
    echo "✓ installed $version to {{skill_dir}}"

# restore a previously archived version
rollback:
    #!/usr/bin/env bash
    set -euo pipefail
    command -v fzf >/dev/null || { echo "fzf required: brew install fzf" >&2; exit 1; }
    [[ -d "{{archive_dir}}" ]] || { echo "no archived versions"; exit 0; }
    pick=$(find "{{archive_dir}}" -maxdepth 1 -mindepth 1 -type d -exec basename {} \; \
        | sort -r | fzf --header="ENTER restores, ESC cancels") || exit 0
    read -r -p "replace installed skill with $pick? [y/N] " reply
    [[ "$reply" == [yY] ]] || { echo "cancelled"; exit 0; }
    if [[ -d "{{skill_dir}}" ]]; then
        current=$(node -p "require('{{skill_dir}}/package.json').version" 2>/dev/null || echo unknown)
        mv "{{skill_dir}}" "{{archive_dir}}/${current}-$(date +%Y%m%d-%H%M%S)"
    fi
    mv "{{archive_dir}}/$pick" "{{skill_dir}}"
    echo "✓ rolled back to $pick"

# remove the installed skill and local dev dependencies
uninstall:
    #!/usr/bin/env bash
    set -euo pipefail
    targets=()
    if [[ -d "{{skill_dir}}" ]]; then targets+=("{{skill_dir}}"); fi
    if [[ -d archify/node_modules ]]; then targets+=("archify/node_modules"); fi
    if [[ ${#targets[@]} -eq 0 ]]; then echo "nothing to remove"; exit 0; fi
    printf '  %s\n' "${targets[@]}"
    read -r -p "remove the above? [y/N] " reply
    [[ "$reply" == [yY] ]] || { echo "cancelled"; exit 0; }
    rm -rf "${targets[@]}"
    echo "✓ uninstalled (archived versions in {{archive_dir}} are kept)"

# rebuild dev dependencies and reinstall the skill
reinstall:
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf archify/node_modules
    just setup
    just install
