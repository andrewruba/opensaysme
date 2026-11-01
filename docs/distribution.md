# macOS distribution

The package contains the compiled application, a private Node runtime, production
dependencies and the native helper. End users need macOS 14+, an API key and the
macOS privacy grants. There is no Homebrew configuration.

## Build and verify

Use the official Node distribution matching `.nvmrc` (nvm works) and Xcode Command
Line Tools on a Mac of the target architecture:

```sh
nvm install
nvm use
npm ci
npm run check
sh native/macos/test.sh
npm run package:macos
```

Output is `release/OpenSaysMe-arm64.pkg` or `release/OpenSaysMe-x64.pkg`, with a
matching `.pkg.sha256`. Packaging installs locked production dependencies from the
npm cache populated by `npm ci`, then tests the extracted runtime without a system
Node on PATH. The Package macOS workflow builds both architectures and tests
installation, bundle replacement and removal on disposable runners.

The installed files live under `/Library/Application Support/OpenSaysMe`, with
`osm` and `opensaysme` commands in `/usr/local/bin`. The application resources use
a nonrelocatable bundle with replacement-on-upgrade semantics so obsolete files
are removed. Existing unrelated installations and commands are rejected.

## Lifecycle

`osm` performs interactive setup when configuration is missing. Setup continues
to store environment-variable references, never API keys. `osm setup --replace`
changes configuration; `osm doctor` checks local readiness without a provider call.

`osm update` finds the latest stable GitHub Release, downloads the matching Mac
package and checksum, verifies the download, and stops this user's running
instance of the installation. macOS requests administrator authentication to
apply the package. The privileged helper checks a protected copy before invoking
Installer, and the CLI checks the installed version before reporting success.
Settings remain outside the package. Run `osm` again after an update. Source
checkouts are never updated by this command. Until a compatible Release is
published, it reports that no package is available.

`osm uninstall` stops this user's running instance, removes the marked package
and its matching command links, and forgets the package receipt. Source installs
remove only their own npm links. Settings are retained; `--purge` also removes
recognized configuration and recent-history files. It does not delete source
checkouts, exported debug captures, environment variables or OS permission grants.
Internal maintenance scripts are called by the CLI; they are not user commands.

CLI maintenance blocks new voice sessions for the invoking user until it completes.
Cancellation is honored before privileged work; once macOS begins an installation
or removal, the CLI waits for that operation rather than interrupting its writes.
Direct package installation also checks for a running native helper and asks the
user to close it first.
On shared Macs, close every user's session before changing the installation;
simultaneous startup by another user is not synchronized.

## Release

Build from the exact tested release tag, with the package, lockfile and README
version aligned. The workflow produces reviewable artifacts, not a public release.
Publish both architecture packages and their matching checksum files on the same
GitHub Release with a `v<major>.<minor>.<patch>` tag. Keep the asset names above
stable: the updater uses those names. Do not replace published assets in place.

These builds are unsigned and not notarized. Downloaded previews may need
**Privacy & Security → Open Anyway**. Add Developer ID signing and notarization
before checksumming when signing is available. Checksums detect a mismatched
download; they do not replace code signing.

Preserve the bundled third-party notices and provide the corresponding sources
required for redistributed native libraries. The current build includes license
texts and pinned source/build references; a complete corresponding-source archive
must be prepared before public distribution. See
[third-party notices](../packaging/macos/THIRD_PARTY_NOTICES.md).
