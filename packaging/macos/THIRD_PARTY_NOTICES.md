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

The libvips source archive alone does not include all its incorporated libraries
or patches. Before publishing installer downloads, preserve the matching complete
dependency sources, patches, build instructions and copyright/license notices,
and provide them alongside the release. Current local builds include these source
references, not a verified complete corresponding-source archive.
