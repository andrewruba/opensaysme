# OpenSaysMe native dependency sources

This companion preserves the source inputs for Sharp 0.35.5 and the
sharp-libvips 1.3.4 binaries used by both OpenSaysMe macOS installers. The matching
libvips version is 8.18.7. OpenSaysMe's own source is in the GitHub release's source
archive. Node's complete upstream notices ship in the installer at `runtime/LICENSE`.

## Contents and verification

`manifest.json` records the original HTTPS URL, byte size and SHA-256 for every
input. `SHA256SUMS` permits independent verification. The archive contains:

- The exact sharp-libvips build recipes and both Mac platform configurations.
- All 28 primary native-library sources, including GLib's vendored GVDB and
  libvips' vendored libnsgif implementation.
- The five externally fetched patches; upstream `sed` modifications remain in
  the preserved build recipe.
- Sharp's source and all 357 registry crates from librsvg 2.63.2's release
  `Cargo.lock`, verified against that lockfile. This is a deliberate superset:
  it includes development, test, disabled-feature and other-platform crates.
- Copyright/license files and matching Rust standard-library notices. The
  installer includes these notices too.

The original librsvg lockfile has SHA-256
`e79e2a2735a0b5b151bb4133becd3008223fabedd34a8b787a872edab9854941`.
Its nine workspace packages are in librsvg's own source archive; it has no Git
dependencies. Upstream's `cargo update --workspace` retains existing external
dependency versions while removing dependencies of disabled features.

The binaries embed Rust commit
`75a75c3e0a67d3fa3d03982775f5bb0356e7b510`, from nightly 2026-09-27. General-purpose
compiler/build tools are prerequisites, not part of this source companion.
These materials preserve the source/build inputs; a bit-for-bit rebuild of the
upstream binaries has not been performed.

## Rebuilding the native library

Use a Mac of the target architecture, Xcode Command Line Tools, Python 3.12+,
Meson, Ninja, CMake, pkg-config, Autotools, NASM, the Rust nightly above, and
`cargo-c` (`cargo-cinstall`). The original upstream requirements and workflow are
in the sharp-libvips source archive. Tool installation may require network access.
The native source downloads and Rust dependencies are supplied here.

Use a build path without spaces, as required by the upstream shell recipes.
From this companion directory:

```sh
shasum -a 256 -c SHA256SUMS
python3 prepare.py
cd native-build/recipes/sharp-libvips-1.3.4
RUSTUP_TOOLCHAIN=nightly-2026-09-27 ./build.sh darwin-arm64v8
```

Use `darwin-x64` on an Intel Mac. `prepare.py` verifies every source input,
materializes Cargo vendor directories with per-file checksums, and adapts the
recipe to read the supplied archives/patches and use an already installed Rust
toolchain. It preserves all upstream compilation flags and native-source edits.
The original recipe remains in its source archive, and acquisition changes are
recorded in `native-build/offline-acquisition.patch`. No build or download happens
when running `prepare.py` itself.

The resulting library is in the recipe's `target/lib-filtered` directory.
OpenSaysMe permits replacement with an interface-compatible, architecture-matched
modified library and reverse engineering to debug those modifications. Quit
OpenSaysMe before replacing this administrator-owned file:

```
/Library/Application Support/OpenSaysMe/OpenSaysMe.bundle/Contents/Resources/node_modules/@img/sharp-libvips-darwin-<arm64-or-x64>/lib/libvips-cpp.8.18.7.dylib
```

Preserve the upstream build's relative install names. A locally modified library
may need ad-hoc code signing on Apple Silicon (`codesign --force --sign -`) before
macOS will load it. OpenSaysMe does not enforce a hash of this library.

## Reproducing notices

`python3 prepare.py --notices native-source-notices.txt` collects original
copyright/license files from all source inputs without extracting or building
their code. This notice set includes unused source components as well as libraries
linked into the binary. The Rust toolchain notices and node-addon-api MIT notice
are preserved separately under `licenses/`, with provenance in the project’s
third-party notices.
