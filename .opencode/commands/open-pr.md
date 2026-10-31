---
description: Open a pull request as the OpenCode bot
agent: build
---

Open a pull request for the current work as the OpenCode bot, so the PR and
its commits are attributed to `<app-slug>[bot]` rather than to the human who
owns the repository.

Arguments: $ARGUMENTS

Steps:

1. Make sure the work is on a feature branch. Never push to `master`. If
   the current branch is `master`, create one first:
   `git switch -c feature/<short-slug>`

2. Review the diff and make sure the change builds and lints clean:

   ```
   npm run build
   npm run lint
   ```

3. Commit any uncommitted changes with a conventional-commit message that
   describes the change, not the tooling.

4. Open the PR:

   ```
   scripts/open-pr.sh <branch> "<title>" <body-file>
   ```

   Write the body to a temporary file first (a summary, what changed and why,
   and how it was verified). `$ARGUMENTS` may override the title.

5. Report the PR URL and the bot identity that authored it.

Notes:

- The script mints a short-lived GitHub App installation token and caches it.
  It never writes a token to the repository, to `.git/config`, or to the
  remote URL.
- The commit author is set through the environment for that command only, so
  the human's own `git config` identity is left untouched.
