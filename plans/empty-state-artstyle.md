# Empty-state illustration art style

Living reference for Emaki empty-state graphics. Update this file whenever the
style is refined so new assets stay consistent.

## Direction

Hand-drawn / sketchbook illustrations — Evernote-like doodles, not soft 3D,
not clay, not photoreal, not perfect vector.

Loose thin ink outlines with slightly imperfect strokes. Sparse grey
watercolor / pencil wash fills. Friendly and personal, still restrained enough
for a modern reader app.

**Working format:** raster PNG (transparent) generated with Nano Banana while
iterating. Convert to SVG only once a given asset (or the whole set) is locked.

## Palette (monotone)

Greys only — drawn from the logo and Everforest theme in
`src/theme/variables.scss`:

| Role        | Hex       | Token      |
| ----------- | --------- | ---------- |
| Primary ink | `#5c6a72` | `--fg`     |
| Mid fill    | `#829181` | `--grey2`  |
| Light wash  | `#939f91` | `--grey1`  |
| Soft accent | `#a6b0a0` | `--grey0`  |

No aqua, cream, multi-hue pastels, or brand accent colours inside the artwork.
The app chrome (`--bg0` cream) shows through the transparent background.

## Composition rules

- Single clear subject, centered, lots of negative space.
- Transparent background (key out white/light fills after generation if needed).
- No text, typography, labels, UI chrome, borders, or frames in the image.
- Illustration is separate from empty-state title, description, and CTA.
- Display size in UI: about **180–220 CSS px** wide — supporting element, not a hero.
- Generate **one illustration per image**; reuse the latest approved asset as the
  style reference for the next.

### Device subjects

- Prefer a **single** device when the state is “no devices”.
- **No hardware decals:** no home button, speaker grille, camera, notch,
  Dynamic Island, volume/power buttons, ports, logos, or icons. Phone = rounded
  rectangle shell + blank screen inset (+ optional tiny sketchy ground shadow).

## Prompt skeleton (Nano Banana)

```
Empty-state hand-drawn illustration for a modern mobile app.
Subject: <one-sentence subject>.
Evernote-like sketchbook style — loose thin imperfect ink outlines,
soft sparse grey watercolor/pencil wash fills.
Strictly monotone greys only (#5c6a72, #829181, #939f91, #a6b0a0).
Transparent or plain white background.
No text, labels, UI, borders, or frames.
No hardware decals on devices (no buttons, speakers, cameras, notches).
Central composition with plenty of negative space.
Friendly drawish journaling aesthetic; recognizable at small size.
```

Attach the latest approved empty-state PNG as a visual reference.

## Assets

| Situation            | File                                         | Status                          |
| -------------------- | -------------------------------------------- | ------------------------------- |
| No devices connected | `src/assets/illustrations/no-devices.png`    | Approved (sketch, no decals)    |
| Empty folder         | `src/assets/illustrations/empty-folder.png`  | Sketch, open blank folder       |
| No history           | `src/assets/illustrations/no-history.png`    | Sketch, closed blank book       |
| No library / books   | —                                            | Not started                     |
| No search results    | —                                            | Not started                     |
| No internet          | —                                            | Not started                     |
| No notifications     | —                                            | Not started                     |

## UI wiring

Empty states keep illustration, copy, and action as separate elements. First
consumer: Sync page when `devices().length === 0`
(`src/app/features/sync/sync.page.html` + `.scss`).

## Changelog

- **2026-11-05** — No history: closed blank book with a bookmark ribbon.
- **2026-11-05** — Empty folder: open blank folder, same monotone sketch as no-devices.
- **2026-11-03** — Soft 3D clay rejected. Switched to Evernote-like hand-drawn
  monotone. Single phone for no-devices; removed all hardware decals. Raster PNG
  for iteration; SVG deferred until style is final.
