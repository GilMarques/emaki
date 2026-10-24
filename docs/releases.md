# Releases

Emaki is not published on the Play Store. Releases are GitHub Release assets:
push a `v*` tag and CI builds a signed APK and attaches it to the release page.

## One-time setup

```bash
scripts/setup-release-secrets.sh          # uses android/release.keystore
```

The script stores four repository secrets: `KEYSTORE_B64` (base64 keystore),
`KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

**Keep the same keystore forever.** Android refuses to install an update
signed with a different key, and there is no Play Store to recover from. The
keystore is not in git (`*.keystore` is ignored), so back it up somewhere else.

## Publishing a release

```bash
npm version 1.2.0          # bumps package.json -> the version shown in the app
git commit -am "chore(release): 1.2.0"
git tag v1.2.0
git push origin master --tags
```

CI then:

1. builds the Angular app and syncs it into the Android project,
2. derives `versionName` / `versionCode` from the tag (`v1.2.0` → `1.2.0` /
   `10203`),
3. builds a signed release APK (arm64-v8a),
4. verifies the signature with `apksigner`,
5. attaches `emaki-v1.2.0.apk` and a `.sha256` file to the GitHub Release.

`versionCode` must increase with every release or devices will reject the
update. The tag is the source of truth for CI; `package.json` is the source of
truth for local builds, so keep the two in sync (`npm version` does that).

### Manual runs

`workflow_dispatch` builds the same APK without a tag:

- **Run workflow** with no input → version taken from `package.json`.
- **Run workflow** with `version: v1.2.0` → builds that version.
- Tick **publish** to attach the APK to a GitHub Release even without a tag.

Every run also stores the APK as a workflow artifact for 30 days.

## Installing

Download `emaki-v<version>.apk` from the release page and open it on the
device (sideloading needs "install unknown apps" permission). Installing a
newer version over an older one keeps the app data; a downgrade requires
uninstalling first.

## Local builds

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease
```

The version comes from `package.json` unless overridden:

```bash
./gradlew assembleRelease -PemakiVersionName=1.2.3 -PemakiVersionCode=10203
```

For a locally signed release, create `android/keystore.properties` (ignored by
git):

```properties
storeFile=release.keystore
storePassword=...
keyAlias=emaki
keyPassword=...
```

Without that file the release build is unsigned and cannot be installed.

## Notes

- The debug sample books in `src/assets/sample/` are git-ignored, so release
  APKs built in CI do not ship them (local release builds do, because the
  assets folder is bundled as-is).
- `native/real-esrgan` compiles ncnn RealSR from source in CI, which needs
  NDK `29.0.14206865` and CMake; expect the first build to take several
  minutes.
