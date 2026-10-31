#!/usr/bin/env bash
#
# Open a pull request as the OpenCode bot.
#
#   scripts/open-pr.sh <branch> <title> [body-file]
#
# The branch is pushed with the GitHub App installation token and the PR is
# created with the same token, so both the commits and the PR show up as
# the bot rather than as the human who owns the repo.
#
# Requires a GitHub App (see scripts/github-app-token.mjs for setup). The
# commit author is set through the environment rather than `git config`, so
# this never rewrites the repo's local identity — the human keeps their own
# name on their own commits.
#
# This acts on the current working directory, not on the directory the
# script lives in, so it works from a worktree.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ $# -lt 2 ]; then
  echo "usage: scripts/open-pr.sh <branch> <title> [body-file]" >&2
  exit 2
fi

BRANCH="$1"
TITLE="$2"
BODY_FILE="${3:-}"
BASE_BRANCH="${OPEN_PR_BASE:-master}"

if [ -n "$BODY_FILE" ] && [ ! -f "$BODY_FILE" ]; then
  echo "body file not found: $BODY_FILE" >&2
  exit 2
fi

command -v gh >/dev/null || { echo "gh CLI not found" >&2; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not in a git repository" >&2; exit 1; }

case "$BRANCH" in
  master|main)
    echo "refusing to push to $BRANCH; name a feature branch" >&2
    exit 2
    ;;
esac

IDENTITY="$(node "$SCRIPT_DIR/github-app-token.mjs" --identity)"
TOKEN="$(node "$SCRIPT_DIR/github-app-token.mjs")"

# The bot's login and its noreply address. GitHub only links a commit to
# the bot account when the address carries the bot's numeric user id.
BOT_NAME="${IDENTITY%% <*}"
BOT_EMAIL="${IDENTITY##*<}"
BOT_EMAIL="${BOT_EMAIL%>}"

export GIT_AUTHOR_NAME="$BOT_NAME"
export GIT_AUTHOR_EMAIL="$BOT_EMAIL"
export GIT_COMMITTER_NAME="$BOT_NAME"
export GIT_COMMITTER_EMAIL="$BOT_EMAIL"

# `gh` reads GH_TOKEN, so the app token authorises the PR as well.
export GH_TOKEN="$TOKEN"

REMOTE="$(git remote get-url origin)"
REPO="$(basename "$REMOTE" .git)"
OWNER="$(basename "$(dirname "$REMOTE")")"

# Commit anything still pending, so the pushed branch matches the working
# tree the agent was asked to publish.
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$TITLE"
fi

echo "Pushing $BRANCH to $OWNER/$REPO as $BOT_NAME"

# The token travels through a one-shot credential helper rather than the
# remote URL, so it never lands in the process list or in .git/config.
# The helper is cleared first: the ambient `gh auth` account would
# otherwise answer and push as the human instead of the bot.
# The -c options must precede the subcommand.
git -c "credential.helper=" \
    -c "credential.helper=!f() { echo username=x-access-token; echo password=\$GH_TOKEN; }; f" \
    push origin "HEAD:refs/heads/${BRANCH}"

PR_ARGS=(pr create --repo "${OWNER}/${REPO}" --head "$BRANCH" --base "$BASE_BRANCH" --title "$TITLE")
if [ -n "$BODY_FILE" ]; then
  PR_ARGS+=(--body-file "$BODY_FILE")
fi

gh "${PR_ARGS[@]}"
