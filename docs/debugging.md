# Debugging Emaki

There are three places to look, in order of convenience.

## 1. In-app log viewer

**Settings → Debug → Debug logs**, or navigate to `/logs`.

- **This session** — the live in-memory buffer, updated as the app logs.
- **Saved file** — what is actually on disk. Open it after a crash or a
  restart to see what led up to it.
- Filter by level (All / Warnings / Errors) or search across tag, message and
  detail. The copy button puts the whole source on the clipboard.
- The file path is printed at the bottom of the page.

What is captured:

- every `console.log` / `info` / `debug` / `warn` / `error` call
- uncaught exceptions (`window.error`)
- unhandled promise rejections
- the session header: platform, URL, viewport, language, user agent

The leading `[tag]` in a console message becomes the entry's tag, so
`console.log('[enhance] pump tick', state)` shows up as tag `enhance`,
message `pump tick`, detail `{...}`. Untagged output gets the tag `app`.

## 2. The log file on the device

Native builds append JSON lines to an app-private file:

```
<app data>/files/emaki-logs/emaki.log       # current
<app data>/files/emaki-logs/emaki.log.1     # previous, after rotation
```

- Flushed once a second and whenever the app goes to the background.
- 1.5 MB per file, one rotated backup (~3 MB total).
- On Android the data dir is `/data/user/0/<appId>/files/`.
- App-private means no storage permission and no prompt; it survives restarts
  and is deleted on uninstall.

Pull it from a **debug** build with `run-as` (no root needed):

```bash
# npm run logs:pull -- emaki.log
# EMAKI_APP_ID=my.other.id npm run logs:pull
npm run logs:pull

# or by hand, oldest lines first:
adb exec-out run-as io.ionic.starter cat files/emaki-logs/emaki.log.1 > emaki.log
adb exec-out run-as io.ionic.starter cat files/emaki-logs/emaki.log >> emaki.log

wc -l emaki.log
```

Use the `appId` from `capacitor.config.ts` if it ever changes. A release build
cannot be read this way — use the in-app viewer and copy instead.

Each line is self-contained:

```json
{"ts":1761310805123,"level":"error","tag":"enhance","message":"pump → enhancePage FAILED","detail":"Error: …\n  at …"}
```

A half-written last line means the process died mid-flush; the parser skips it,
so do the same when reading by hand.

## 3. Live console and logcat

- **Web / `npm start`** — the browser DevTools console works as usual.
- **Android, JS console** —

  ```bash
  adb logcat -s Capacitor/Console
  # or only this app:
  adb logcat -s Capacitor/Console --pid=$(adb shell pidof io.ionic.starter)
  ```

  On native the console wrapper pre-formats arguments to a single string, so
  logcat shows the object contents instead of `[object Object]`.

  > Capacitor's own bridge trace lines (`native-bridge.js`, logged with an
  > empty file name and a line number like 333/349) still print
  > `[object Object]`. Those come from the bridge before your code sees them;
  > they are not entries from the app's logger.

- **Android, native crashes / Java side** — these never reach the WebView:

  ```bash
  adb logcat -s AndroidRuntime
  adb logcat | grep -i "io.ionic.starter"
  ```

## Logging from code

Two options, both captured by the same store:

```ts
// Existing style: automatic tag parsing, also visible in DevTools/logcat.
console.log('[download] queued', { chapter, pages });

// Structured, no console echo — use when the logger is already injected.
private readonly logs = inject(LogService);
this.logs.info('enhance', 'page enhanced', { bookId, pageIndex, ms });
```

Prefer short, stable tags (`shelf`, `enhance`, `download`, `logs`, `provider`).
Keep the expensive part out of the log call — formatting happens synchronously:

```ts
// Don't format megabytes just to log whether something is there.
console.log('[scan] found', entries.length, 'entries');
```

## Limits and warnings

- 2000 entries in memory, newest 400 rendered. Older lines are dropped.
- One field is capped at 4000 characters; errors keep their stack.
- Nothing leaves the device automatically, but logs can contain provider URLs,
  file paths and page names. Read before pasting into an issue.
- On web and Tauri there is no file sink: use the in-app buffer and DevTools.
