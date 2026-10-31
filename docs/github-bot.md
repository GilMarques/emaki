# GitHub bot identity

OpenCode has no identity of its own on GitHub — the credential does. Two
things have to point at the bot for a PR to look like a bot's work:

- **The token** that pushes the branch and opens the PR decides who the PR
  is authored by.
- **The commit author** (`git config user.name` / `user.email`) decides who
  the commits are attributed to.

Without this, an agent working in a session pushes as whichever account the
local `gh` CLI happens to be logged in as, and the PR shows up as a human.

This repo uses a **GitHub App** for that. The app is installed on this
repository only, and the private key lives outside the repo, so a leaked
token expires within an hour and grants access to nothing else.

## One-time setup

1. Create the app: <https://github.com/settings/apps/new>
   - Name: `opencode` (the bot account will be `opencode[bot]`)
   - Repository permissions:
     - Contents: **Read and write**
     - Pull requests: **Read and write**
     - Metadata: **Read** (required)
   - "Only on select repositories" → pick `GilMarques/emaki`
   - Leave the webhook empty
2. Generate a private key and save it **outside the repository**:

   ```
   mkdir -p ~/.config/opencode
   mv opencode.*.pem ~/.config/opencode/github-app.pem
   chmod 600 ~/.config/opencode/github-app.pem
   ```

3. Write the credentials to `~/.config/opencode/github-app.json`:

   ```json
   {
     "appId": "123456",
     "installationId": "9876543",
     "privateKeyPath": "~/.config/opencode/github-app.pem"
   }
   ```

   The app id is on the app's settings page; the installation id is in the
   URL after installing it (`/settings/apps/opencode/installations/<id>`).
   `appSlug` is optional — it is looked up when missing.

   Every field can also come from the environment (`GITHUB_APP_ID`,
   `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_SLUG`,
   `GITHUB_APP_PRIVATE_KEY`), which is what a CI job would do.

## Using it

Open a pull request as the bot:

```bash
scripts/open-pr.sh feature/my-change "feat(x): short description" /tmp/pr-body.md
```

Or from OpenCode, use the `/open-pr` command.

`scripts/github-app-token.mjs` is the lower-level piece — it mints an
installation token and reports the bot's git identity:

```bash
node scripts/github-app-token.mjs            # token on stdout
node scripts/github-app-token.mjs --json     # token + bot name and email
node scripts/github-app-token.mjs --identity # "opencode[bot] <id+opencode[bot]@users.noreply.github.com>"
```

The token is cached in `~/.cache/opencode/github-app-token.json` and renewed
five minutes before it expires.

## Why the commit email looks like it does

GitHub only links a commit to a bot account when the author address carries
the bot's **numeric user id** plus its login:

```
<user-id>+<login>[bot]@users.noreply.github.com
```

The app id is a different number — using it produces a commit that is not
linked to the bot and shows up as an unverified author. The id is fetched
from `/users/<login>[bot]` and is not the app id.

## Secrets

The private key is the only long-lived secret. Keep it at
`~/.config/opencode/github-app.pem` with mode 600, and keep it out of the
repository. Installation tokens are short-lived (one hour) and are only ever
held in memory or in the cache file above.
