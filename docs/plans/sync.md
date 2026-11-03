# Multi-device Sync — Implementation Plan

## Context

Three devices, three jobs:

| Device | Job | Needs |
| ------ | --- | ----- |
| Computer | Owns the library, enhances pages | Write access, the only writer |
| Laptop | Bed reading | Read + download ahead |
| Phone | Outside reading | Read + download ahead, offline |

What exists today is a fraction of that: `SyncService`/`LanSyncTransport` push the *enhanced pages of
one book* from a computer to a phone over the LAN, and stop there.

## Goal

- Any number of paired devices — target three — sharing **one library**.
- **Reading state syncs everywhere**: last page per book, so a book opens where you left it, on any
  device, even before its pages are downloaded.
- **Pages are downloaded whole and then read offline.** Never streamed, never fetched page-by-page.
- The computer stays the only device that can write to the library.

## Current state

- **Push-only sync.** `SyncService.pushBook` sends one book's enhanced derivatives; nothing flows
  back and nothing but pages flows at all.
- **Book identity is a local path.** `fs:<absolute path>` (`filesystem-library.scanner.ts`),
  `__chapter__:<provider>:<chapter>` (downloads). The same book on two machines is two books.
- **Received bytes are a dead end.** `SyncEndpointPlugin.handleBook` writes to
  `filesDir/emaki/synced/<bookId>/` and no code in `src/app` reads that directory — the phone
  receives pages it cannot open.
- **Reading state is device-local.** `HistoryService` is a 100-entry localStorage list;
  `ShelfService` progress is not persisted at all.
- **Done:** the `/sync` page (`features/sync/`), MEGA sign-in with a revocable session, the pack
  format, publishing to `Emaki/`, and the catalogue that reads it back.

## Architecture

### Two planes

| | Journal (state) | Blobs (bytes) |
| --- | --- | --- |
| Content | position, furthest, bookmarks, catalog, enhancement badges | originals and derivatives |
| Size | kilobytes | gigabytes |
| Latency | seconds | whenever |
| Transport | anything that moves small JSON | LAN first, cloud when away |

Solve the journal first: three devices *feel* synced before a single byte of manga moves, and it is
the cheap 90% of the bed/outside split.

### Portable identity

- Provider chapters are already global: `dl:<providerId>:<chapterId>`. Keep.
- Local scans become `bk:<16hex>`, hashed over normalized title + page count + the sorted
  `name:size` list of the folder. No page bytes read at scan time; a copy of the folder on the laptop
  hashes identically.
- Store the local path as a *mapping*, never as the id. `cacheKeyString` in `page-asset.service.ts`
  then becomes portable too, which derivative sharing depends on.

### Journal

Per-device append-only journals, replicated peer to peer:

```
journal/<deviceId>.jsonl   { seq, hlc, type, payload }
```

Sync is "send me your lines after cursor N" — no write conflicts at the transport level, and
transitive through whichever device is reachable. Compact with a snapshot record so a new device does
not replay years of lines.

One record per book:

```ts
interface ReadingRecord {
  bookId: string;
  position: number;                  // resume point — last writer wins
  furthest: number;                  // high-water mark — max()
  hlc: [wallMs, counter, deviceId];  // survives clock skew
  pageCount: number;
  deleted?: true;                    // tombstone, 30-day retention
}
```

- `position` merges by HLC, not raw wall clock.
- `furthest` merges by `max` and never regresses, so reserving at page 4 on the laptop cannot erase
  "read to 40" from the phone.
- **Never silently rewind.** If the incoming position is far behind the local furthest, open the book
  with a "continue here / continue there" prompt instead of jumping.

### Blobs

One pack per book, pages concatenated, plus an index:

```
Emaki/bk-<hash>/pages.pack
Emaki/bk-<hash>/index.json     page → offset/length, sha256, model, scale
```

Packs keep object count sane (one node per book, not 200) and make a download a single resumable
transfer. On arrival the pack's pages go into the local store already served by `FilePageService` and
`PageAssetService`, so the reader needs no new page source.

### Transports

Everything sits behind ports so the path is not the protocol:

```
BlobStore        put / get / list / remove
JournalTransport exchange lines after a cursor
```

- **LAN** (exists today) for bulk when both devices are home.
- **Firestore** for the journal — reachable from a train, no port forwarding.
- **MEGA account** for blobs: every device signs in and reads `Emaki/`.

### Roles as capabilities

Presets over capabilities, not device types: `library:source`, `enhance:on`, `holds:originals`,
`auto-pull:current-series`. The enhancement queue becomes a journal event — the PC enhances,
publishes "enhanced available", the others pull.

## Backend decisions

**Journal → Firestore (Spark).** 1 GiB, 50K reads / 20K writes per day, no idle pause, offline queue
and listeners built into the SDK. One document per device per sync (`{ seq, snapshot, tail[] }`),
sealed with a group key so Google only ever sees ciphertext. Auth: one Firebase account the user
owns, rules `request.auth.uid == uid`. No OAuth consent screen, no verification, no publishing step —
that trap belongs to the Google Drive API, not Firebase.

**Blobs → MEGA, one account on every device.** Every device signs in to the same account and reads
and writes the same `Emaki/` folder. This is a deliberate standardisation: one code path, one place a
book can come from, no link to paste or re-export. The cost is explicit — a device that can read the
library can also publish to it, so the credential is write-capable everywhere. What is *not* shared is
the password: only a session token from `storage.toJSON()` is kept, and MEGA can revoke it per device
from the account's Security page.

If the account is on a Pro plan, prefer **MEGA S4** (S3-compatible, included with Pro Lite/I/Flexi,
€3.50/TB beyond 3 TB, 5× egress) — same adapter shape as R2, no unofficial client, no password on any
device.

Rejected, with reasons: Google Drive / OneDrive / Dropbox (OAuth app setup for a feature that
download-first does not need), Supabase free (1 GB storage, **50 MB per file**, pauses after 7 days
idle), Cloudflare R2 (best engineering, but another account; still the right fallback behind the S3
adapter).

**Appwrite — considered, not chosen.** Open source and self-hostable (Docker/Helm), and one platform
for both planes, which is tempting. Cloud Free gives 500K DB reads + 250K writes per month, 250
realtime connections, 2M realtime messages, 2 GB storage — plenty for a journal. What rules it out
here:

- **Free projects pause after one week of inactivity**, and freeze when a limit is hit. For a sync
  backend that is the wrong failure mode: history silently stops travelling.
- **50 MB file size limit** on Free (2 GB total), so it cannot hold packs either — a pack is
  50–300 MB, and 2 GB is smaller than the library.
- No offline-first SDK layer comparable to Firestore's, so the phone would still need its own queue.
  (Neutral for us: Dexie is the source of truth regardless.)

It becomes interesting only as a *self-hosted* replacement for Firestore, ideally pointed at
S3-compatible storage (MEGA S4 or R2) for blobs — a tidy single stack, at the cost of running a
server.

## UI

- `/sync` (done): MEGA sign-in / account, connection health, paired devices.
- `/library` (done): a **This device | MEGA** switch. MEGA shows the account's books as a grid with
  previews; publishing is a header action on the device shelf.
- Next on Library: a download action per MEGA book, and an on-device marker. Queue progress already
  has a home in the sidebar's Tasks section.

## Phased steps

1. **Sync page** — route, nav entry, `DeviceUiService`, then MEGA sign-in with a revocable session.
   *Done.*
2. **Pack format + manifest** — `index.json` schema, the catalogue that reads it, the writer that
   produces it, and publishing it to MEGA *(done: format, validation, `readRemoteCatalog`,
   `buildPack`, `MegaAccountBlobStore`, sign-in + publish on the Sync page)*. Remaining: a reader
   that opens a downloaded pack through the existing page services.
3. **Download engine** — list → choose → fetch with progress → local store, on top of
   `BlobStore`. The `/sync` page grows a download action and an on-device marker.
4. **Journal** — Dexie tables (`books`, `reading`, `devices`, `journal`, `cursors`), portable ids at
   scan time, HLC merge, journal over Firestore.
5. **Three-device pass** — computer writes, laptop and phone read; resume prompt; verify the whole
   loop on real hardware.
6. **Enhancement as a journal event** — "enhanced available" propagates without pushing books.

## Decisions (locked)

1. **Offline-first.** Books are downloaded in full, then read. Range support and streaming latency are
   not criteria for the blob backend.
2. **Journal on Firestore; blobs on MEGA.** Two providers, each doing what it is good at.
3. **Every device signs in to MEGA.** One account, one `Emaki/` folder, no folder links. A device
   that can read the library can also publish to it — accepted for the sake of one code path.
4. **Identity** — `bk:<hash>` for local scans, `dl:<provider>:<chapter>` for provider chapters; local
   paths are a mapping.
5. **Merge** — per-book LWW on `position` via HLC, `max` on `furthest`, tombstones for deletes.
6. **No CRDT library.** Per-book LWW + max covers reading position.
7. **Only a session token is stored**, never the password, and MEGA can revoke it per device.
8. **No double encryption.** MEGA's file keys protect blobs; our own group key seals the journal.
9. **Pairwise secrets for transport**, one group key for the journal at rest.

## Open questions

- Should a pack be deleted automatically once a book is finished, or only on request? (Needs a policy
  before the download engine ships.)
- Does the laptop keep its own copy of the source files, or read from the computer over the LAN?
- Is the MEGA account on a Pro plan (S4 available) or free (20 GB)?
- Is there an always-on host worth self-hosting the journal on (Appwrite in Docker), instead of
  trusting a cloud free tier not to pause?

## Explicitly deferred

Streamed/range page reads, per-page position, S4/R2/Drive/OneDrive adapters, SMB/SFTP/OPDS, bookmarks,
cloud-to-cloud migration, sharing outside the household.
