# Bundled third-party software

OpenSaysMe is MIT licensed; see `LICENSE`. The installer includes a private Node.js
runtime and production npm dependencies, which retain their own licenses.

Node.js 26.13.0 includes its complete upstream license and component notices at
`runtime/LICENSE`. Matching sources are available from
<https://nodejs.org/dist/v26.13.0/> and
<https://github.com/nodejs/node/tree/v26.13.0>.

Production npm packages retain their upstream package files under `node_modules`,
including supplied license files, notices, and version metadata. Sharp 0.35.5 and
its native binding use Apache-2.0; their licenses are included in their package
directories. Matching Sharp source: <https://github.com/lovell/sharp/tree/v0.35.5>.
The Sharp binding also uses node-addon-api headers; their MIT attribution is in
[node-addon-api-LICENSE.md](licenses/node-addon-api-LICENSE.md), preserved from
<https://github.com/nodejs/node-addon-api/blob/v8.9.2/LICENSE.md>.

## libvips

Sharp dynamically loads libvips 8.18.7 from `@img/sharp-libvips-darwin-arm64` or
`@img/sharp-libvips-darwin-x64`, version 1.3.4. This shared library is distributed
under LGPL-3.0-or-later and incorporates the libraries listed in
[the preserved upstream notices](licenses/sharp-libvips-1.3.4-NOTICES.md).
Its installed `versions.json` identifies the exact component versions.

The library remains a separate `.dylib` under its npm package's `lib` directory.
OpenSaysMe does not prohibit replacing it with an interface-compatible modified
version or reverse engineering to debug those modifications.

License texts included here:

- [LGPL version 3](licenses/LGPL-3.0.txt).
- [GPL version 3](licenses/GPL-3.0.txt), incorporated by the LGPL.
- [MPL version 1.1](licenses/MPL-1.1.txt), identified by upstream for Cairo.
- [Apache version 2.0](licenses/sharp-libvips-build-APACHE-2.0.txt), for the build scripts.

Corresponding upstream source and build references:

- [sharp-libvips 1.3.4](https://github.com/lovell/sharp-libvips/tree/v1.3.4).
- [Dependency versions](https://github.com/lovell/sharp-libvips/blob/v1.3.4/versions.properties).
- [macOS build recipe, source URLs, patches and flags](https://github.com/lovell/sharp-libvips/blob/v1.3.4/build/posix.sh).
- [Apple Silicon configuration](https://github.com/lovell/sharp-libvips/tree/v1.3.4/platforms/darwin-arm64v8).
- [Intel configuration](https://github.com/lovell/sharp-libvips/tree/v1.3.4/platforms/darwin-x64).
- [libvips source](https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz).

The release's `OpenSaysMe-native-sources.tar.gz` companion supplies all 28 native
sources, five patches, Sharp/build-recipe sources and all 357 Rust crates from
librsvg's release lockfile. It includes SHA-256 provenance and offline acquisition
instructions for rebuilding either Mac architecture. GLib's GVDB and libvips'
libnsgif sources are included in their respective source archives. The companion
uses a source superset, including unused features and development dependencies.

This software is based in part on the work of the FreeType Team.
This software is based in part on the work of the Independent JPEG Group.

[Native source notices](licenses/native-source-notices.txt) preserve the original
copyright and license files from those inputs. These notices include components
that are not linked into the shipped library.

Both Mac binaries embed Rust commit `75a75c3e0a67d3fa3d03982775f5bb0356e7b510`,
nightly 2026-09-27. The matching standard-library notices are preserved in
[Rust-COPYRIGHT-library.html](licenses/Rust-COPYRIGHT-library.html), together with
the Rust copyright, MIT and Apache license files. They were extracted from the
[official nightly compiler distribution](https://static.rust-lang.org/dist/2026-09-27/rustc-nightly-aarch64-apple-darwin.tar.xz),
verified against its
[release manifest](https://static.rust-lang.org/dist/2026-09-27/channel-rust-nightly.toml).
The compiler archive SHA-256 is
`7f1c9afbfbb59965bb9e0bd84fa7aeb0ce77e8044880de54fd762bff725200d3`.
