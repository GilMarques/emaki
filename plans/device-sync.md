# Device sync — pair a computer with the phone and hand over processed pages

## Goal

The phone is the reader; the computer is the workshop. Scans live on the
computer (a folder picked in the browser), get enhanced there, and the finished
pages are pushed to the phone — encrypted, without any server in between.

```
computer (browser)                     phone (Android)
──────────────────                     ───────────────
picks a folder      ── File System Access API
enhances pages     ── WebGPU / onnxruntime-web
pairs with the phone ── one-time QR code (secret never hits the network)
pushes .enhanced/   ── HTTP on the LAN, every body AES-256-GCM encrypted
                     → files land in app storage, ready for the reader
```

## Why the QR code comes from the phone

The screenshot this is modelled on has the *computer* mint the QR code. A
browser cannot listen on a socket, so the computer cannot be the thing that is
"connected to" — something has to accept the connection. The phone is a native
app and can, so **the phone runs the endpoint and shows the QR code**, and the
computer scans it (camera, or copy/paste of the same code).

The QR carries a one-time payload (`emaki-pair-v1.<base64url json>`):

```json
{ "v": 1, "id": "<device id>", "name": "Pixel 8", "mode": "home-network",
  "host": "192.168.1.50", "port": 38471, "secret": "<32 random bytes>",
  "exp": 1760000000000 }
```

The secret is handed over directly (camera or paste), never over the network.
Both sides derive the same keys from it:

```
AES-256-GCM key = HKDF-SHA256(secret, salt="emaki-pair-v1", info=<purpose>)
  purpose "emaki-sync-control" → pairing, status, book metadata
  purpose "emaki-sync-files"    → the page bytes
```

So the LAN only ever carries ciphertext. A relay could carry the same bytes
without being able to read them — which is what makes the "anywhere" mode
possible later.

## Modes

| Mode | Who enforces it | Meaning |
|---|---|---|
| `home-network` | the phone | requests from outside a private address range are refused |
| `this-computer` | the phone | the pairing is bound to one computer id; another computer is refused |
| `anywhere` | the relay | the phone accepts anything; a relay carries the bytes (not implemented yet) |

## Layout

```
src/app/core/sync/
  pairing.model.ts        payload format, encode/decode, base64url
  pairing.crypto.ts       HKDF + AES-GCM seal/open (WebCrypto)
  device-registry.service.ts   paired devices (localStorage)
  sync-transport.port.ts  the interface a transport implements
  lan-sync.transport.ts   direct HTTP to the phone's endpoint
  sync.service.ts         pairing, pushing a book, progress
  qr.service.ts           QR encode (phone) / decode (computer)

src/app/core/native/sync-endpoint.plugin.ts   typed proxy for the native plugin
native/sync-endpoint/android/…/SyncEndpointPlugin.java
                          the endpoint: socket server, HKDF/AES-GCM, file inbox

src/app/features/settings/
  add-device.component.ts   "Add a device" (computer): scan / paste the code
  pair-device.component.ts  "Pair a computer" (phone): show the QR code
  send-book.component.ts    pick a book and hand it over
```

## Protocol (encrypted bodies)

| Route | Body | Answer |
|---|---|---|
| `POST /pair` | `{action, computerName, computerId, mode}` | `{ok}` |
| `POST /status` | `{action}` | `{deviceName, pairedComputer, books}` |
| `POST /book` | `{action, book:{id,title,pageCount,model,scale}, fileCount}` | `{ok}` |
| `POST /file` | raw ciphertext; `X-Emaki-Book`, `X-Emaki-File`, `X-Emaki-Mime` | `{ok}` |
| `POST /book-done` | `{action, bookId}` | `{ok}` |

Every body is `iv (12 bytes) || AES-GCM ciphertext`. The phone answers with the
same shape, so the computer can decrypt the reply. `OPTIONS` is answered with
the CORS headers the browser needs for the cross-origin request to the phone's
IP address.

## What the phone does with the files

Files arrive in `<app files>/emaki/synced/<bookId>/<file>`. The plugin keeps a
manifest of received books; the reader side (listing them in the shelf) is the
next slice.

## Limits

- The LAN transport needs the web app to be served over `http` (or
  `localhost`); a hosted `https` build would treat `http://<phone-ip>` as mixed
  content. That is what the relay transport is for.
- The computer reads the whole page into memory before pushing it. Fine for
  single pages, not for archives.
- The pairing secret is a bearer secret: whoever has it can push. The
  "this-computer" mode binds it to one machine; beyond that, an ECDH key
  exchange would be the next step.
