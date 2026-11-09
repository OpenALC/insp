# Android

Android uses the shared Vue/Tiptap interface and the Tauri Rust repository. Notes, groups, images and sync configuration are encrypted before being committed to the app-private SQLite store. Android's system file picker supplies image bytes through the WebView file input; the app encrypts imported attachments and decrypts them into temporary Blob URLs while unlocked.

## Build

Install Android SDK platform 36, build-tools 36.0.0, NDK 27.0.12077973, JDK 21, Node.js, Rust, and the `x86_64-linux-android` Rust target. Keep SDK and JDK paths in ignored `local.properties` or the local shell environment; do not commit machine-specific paths or signing credentials.

On Windows PowerShell, set `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_NDK_HOME`, and `JAVA_HOME` for the current build process. For the x86_64 Rust build, point the target-specific `CC_x86_64-linux-android`, `CXX_x86_64-linux-android`, and `CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER` variables to the NDK's `x86_64-linux-android24-clang.cmd` and `clang++.cmd` wrappers. Keep `CC` and `CXX` host-wide values unchanged; the target-qualified variables select NDK compilers for Android-only crates while host build scripts retain their Windows toolchain.

The Windows Tauri CLI build also creates a symlink for the native library under `jniLibs`. Windows Developer Mode or the symbolic-link privilege is required for that CLI step. Linux CI does not need this Windows permission.

If the Windows symlink step is unavailable, the already compiled library can be copied into `jniLibs/x86_64` before running the existing Gradle assemble task. Recompile the Rust app crate against the current frontend first: copying newer `dist` files beside an old `.so` does not replace the embedded frontend. Confirm the running WebView's entry script against the bundle generated for that Android build; platform build variables can produce a different entry hash from Windows or HarmonyOS.

```powershell
npm ci
npm run tauri -- android init --ci --skip-targets-install
npm run tauri -- android build --debug --apk --target x86_64
```

The generated Android project is in `src-tauri/gen/android`. The project pins compile and target SDK to 36 to match the checked-in CI toolchain. Release APKs and signing configuration should be handled by CI or the developer's local environment, not committed.

## Runtime behavior

- Android back presses dispatch a cancelable `insp:back` event. The shared UI can close its navigation drawer, return from the editor after saving, or let the platform close the app from the note list.
- When the software keyboard is visible, Android consumes the first Back to dismiss it; the next Back closes an open group dialog before closing the drawer or leaving the editor.
- `visibilitychange`, `pagehide`, and Tauri's Android suspended event flush the pending note and image saves before the app backgrounds.
- Image selection uses Android's system document/media picker without broad storage permissions. Imported images become app-private attachments.
- The `tauri.android.conf.json` platform configuration sets Android's minimum SDK and is merged with the shared `tauri.conf.json` by the Tauri CLI.
- Ordinary notes reopen automatically using the Keystore-protected local credential. Legacy encrypted vaults require the original password once to migrate device access. Private notes are hidden from ordinary lists and search, and require system authentication or an independent privacy password to reveal. New private notes default to local-only storage; syncing one requires an explicit change to its sync policy.
- Native HTTP carries encrypted sync records to the Linux service. Production endpoints use HTTPS; local development endpoints can use HTTP. Android emulators can use `adb reverse tcp:8787 tcp:8787` to reach a host service bound to loopback.

For an ARM64 phone, install the `aarch64-linux-android` Rust target and build with `npm run tauri -- android build --debug --apk --target aarch64`. On Windows use the corresponding `aarch64-linux-android24` NDK compiler wrappers. The Gradle ABI directory is `arm64-v8a` and the debug assemble task is `:app:assembleArm64Debug`.

With NDK r27, the Rust build script links the Android shared library with 16 KB page alignment. CI checks both the packaged ELF LOAD segments and the APK's uncompressed library offsets for ARM64 and x86_64. ZIP alignment alone does not fix a 4 KB ELF. See [Android's 16 KB page size guide](https://developer.android.com/guide/practices/page-sizes).

## Emulator verification

On 2026-11-09, the API 36 x86_64 emulator ran the current encrypted-vault APK. The installed package and the WebView's actual entry script were checked against the Android build output. Interface operations covered groups, rich-text notes, PNG selection through Android Photo Picker, mind-map list/tree views, and recovery after force-stop, relaunch and password unlock.

The emulator received and opened Windows and HarmonyOS notes, images, groups and maps through the Linux sync service. Private notes remained absent from ordinary lists and appeared in the password-protected area after explicit sync opt-in. Light mode rendered body text as `#000000`; dark mode used `#d4d4d4`. The updated launcher icon had no black border.

After the origin device disabled private-note sync, a manual sync removed the downloaded note from both the authenticated private area and ordinary lists. The origin retained its local copy. App DB/WAL checks found encrypted records, empty legacy plaintext tables, and no plaintext test markers.

The Gradle Wrapper uses the official `downloads.gradle.org` distribution endpoint and allows 60 seconds for downloads. CI previously hit the default 10-second timeout and HTTP 504 responses from `services.gradle.org` before Gradle could compile the project.
