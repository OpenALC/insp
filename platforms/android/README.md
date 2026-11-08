# Android

Android uses the shared Vue/Tiptap interface and the Tauri Rust repository. Notes and image attachments are stored in the app's private data directory. Android's system file picker supplies image files through the WebView file input; the app imports their bytes into the local attachment store and resolves them through Tauri's asset protocol.

## Build

Install Android SDK platform 36, build-tools 36.0.0, NDK 27.0.12077973, JDK 21, Node.js, Rust, and the `x86_64-linux-android` Rust target. Keep SDK and JDK paths in ignored `local.properties` or the local shell environment; do not commit machine-specific paths or signing credentials.

On Windows PowerShell, set `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_NDK_HOME`, and `JAVA_HOME` for the current build process. For the x86_64 Rust build, point the target-specific `CC_x86_64-linux-android`, `CXX_x86_64-linux-android`, and `CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER` variables to the NDK's `x86_64-linux-android24-clang.cmd` and `clang++.cmd` wrappers. Keep `CC` and `CXX` host-wide values unchanged; the target-qualified variables select NDK compilers for Android-only crates while host build scripts retain their Windows toolchain.

The Windows Tauri CLI build also creates a symlink for the native library under `jniLibs`. Windows Developer Mode or the symbolic-link privilege is required for that CLI step. Linux CI does not need this Windows permission.

```powershell
npm ci
npm run tauri -- android init --ci --skip-targets-install
npm run tauri -- android build --debug --apk --target x86_64
```

The generated Android project is in `src-tauri/gen/android`. The project pins compile and target SDK to 36 to match the checked-in CI toolchain. Release APKs and signing configuration should be handled by CI or the developer's local environment, not committed.

## Runtime behavior

- Android back presses dispatch a cancelable `insp:back` event. The shared UI can close its navigation drawer, return from the editor after saving, or let the platform close the app from the note list.
- `visibilitychange`, `pagehide`, and Tauri's Android suspended event flush the pending note and image saves before the app backgrounds.
- Image selection uses Android's system document/media picker without broad storage permissions. Imported images become app-private attachments.
- The `tauri.android.conf.json` platform configuration sets Android's minimum SDK and is merged with the shared `tauri.conf.json` by the Tauri CLI.

The emulator build targets x86_64. Add `aarch64-linux-android` only when building a device APK or release artifact for ARM64.
