#!/usr/bin/env python3
"""Verify and materialize the preserved native sources; never download or compile."""

import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import sys
import tarfile


def sha256(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def extract(archive_path, destination):
    # Python's data filter rejects absolute/escaping paths, device nodes and links
    # outside this private extraction directory.
    with tarfile.open(archive_path) as archive:
        archive.extractall(destination, filter='data')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('native-build'))
    parser.add_argument('--notices', type=Path, help='Generate a source-superset copyright/license notice file only')
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        raise RuntimeError('Python 3.12 or newer is required for safe archive extraction.')
    bundle = Path(__file__).resolve().parent
    manifest = json.loads((bundle / 'manifest.json').read_text())
    for item in manifest['inputs']:
        path = bundle / item['path']
        if path.stat().st_size != item['size'] or sha256(path) != item['sha256']:
            raise RuntimeError('Source checksum mismatch: ' + item['path'])

    if args.notices:
        texts = ['# Native dependency source notices\n\n'
                 'Preserved copyright and license files from the complete native source inputs.\n'
                 'This includes a superset of Rust crates (tests, tools and other platforms);\n'
                 'inclusion here does not imply every component is linked into OpenSaysMe.\n']
        for item in manifest['inputs']:
            if item['path'].startswith('patches/'):
                continue
            with tarfile.open(bundle / item['path']) as archive:
                for member in archive:
                    basename = Path(member.name).name.lower()
                    named_notice = re.fullmatch(r'((licen[cs]e|copying|copyright|notice|patents?|authors|unlicense)([._-].*)?|ftl\.txt|readme\.ijg)', basename)
                    license_directory = any(part.lower() == 'licenses' for part in Path(member.name).parts[:-1])
                    freetype_codec_notice = item['path'].startswith('archives/freetype-') and member.name.endswith(('/src/bdf/README', '/src/pcf/README'))
                    if not member.isfile() or not (named_notice or license_directory or freetype_codec_notice):
                        continue
                    if member.size > 4 * 1024 * 1024:
                        raise RuntimeError('Unexpectedly large license: ' + member.name)
                    raw = archive.extractfile(member).read()
                    try:
                        text = raw.decode('utf-8')
                    except UnicodeDecodeError:
                        text = raw.decode('latin-1')
                    texts.append('\n\n' + '=' * 72 + '\n' + item['path'] + ': ' + member.name + '\n' + '=' * 72 + '\n\n' + text)
        args.notices.parent.mkdir(parents=True, exist_ok=True)
        # Normalize transport whitespace while preserving the license wording.
        args.notices.write_text('\n'.join(line.expandtabs().rstrip() for line in ''.join(texts).splitlines()) + '\n', encoding='utf-8')
        print('Preserved native source notices:', args.notices)
        return

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    try:
        recipes = output / 'recipes'
        recipes.mkdir()
        extract(bundle / 'archives/sharp-libvips-1.3.4.tar.gz', recipes)
        recipe = recipes / ('sharp-libvips-' + manifest['libvipsBundle'])
        vendor = output / 'vendor'
        vendor.mkdir()
        crates = [item for item in manifest['inputs'] if item['path'].startswith('crates/')]
        for item in crates:
            extract(bundle / item['path'], vendor)
            package = vendor / Path(item['path']).name.removesuffix('.crate')
            files = {str(path.relative_to(package)): sha256(path)
                     for path in sorted(package.rglob('*')) if path.is_file() and path.name != '.cargo-checksum.json'}
            (package / '.cargo-checksum.json').write_text(json.dumps({'files': files, 'package': item['sha256']}) + '\n')
        cargo_config = output / 'cargo-config.toml'
        cargo_config.write_text('[source.crates-io]\nreplace-with = "vendored-sources"\n'
                                '[source.vendored-sources]\ndirectory = ' + json.dumps(str(vendor)) + '\n')

        # Adapt acquisition only: keep the preserved upstream build flags, native
        # source edits, patches and platform files unchanged.
        original = (recipe / 'build/posix.sh').read_text()
        source = original
        start = source.index('  # Local rust installation')
        end = source.index('\nfi', start)
        source = source[:start] + '  export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"' + source[end:]
        bootstrap = re.compile(r'if \[ "\$DARWIN" = true \]; then\n  curl --proto.*?\nfi', re.S)
        source, count = bootstrap.subn('if [ "$DARWIN" = true ]; then\n'
                                      '  command -v cargo >/dev/null\n'
                                      '  command -v cargo-cinstall >/dev/null\n'
                                      '  export RUSTFLAGS+=" -Zlocation-detail=none -Zfmt-debug=none"\nfi', source, count=1)
        if count != 1:
            raise RuntimeError('Unexpected Rust bootstrap recipe; review this source version.')
        shim = output / 'source-download.py'
        shim.write_text('#!/usr/bin/env python3\nimport json,pathlib,sys\n'
                        'bundle=pathlib.Path(' + repr(str(bundle)) + ')\n'
                        'manifest=json.loads((bundle/"manifest.json").read_text())\n'
                        'sources={i["url"]:bundle/i["path"] for i in manifest["inputs"]}\n'
                        'sources["https://raw.githubusercontent.com/lovell/sharp-libvips/main/THIRD-PARTY-NOTICES.md"]='
                        'pathlib.Path(' + repr(str(recipe / 'THIRD-PARTY-NOTICES.md')) + ')\n'
                        'args=sys.argv[1:];url=args[-1];source=sources.get(url)\n'
                        'if source is None: raise SystemExit("Unpreserved source URL: "+url)\n'
                        'data=source.read_bytes()\n'
                        'if args==["-O",url]: pathlib.Path(url.rsplit("/",1)[1]).write_bytes(data)\n'
                        'elif args==[url]: sys.stdout.buffer.write(data)\n'
                        'else: raise SystemExit("Unexpected source-download arguments")\n')
        shim.chmod(0o755)
        downloader = 'source_download() { python3 ' + shlex.quote(str(shim)) + ' "$@"; }\nCURL=source_download'
        source, count = re.subn(r'^CURL=.*$', lambda _: downloader, source, count=1, flags=re.M)
        if count != 1:
            raise RuntimeError('Unexpected downloader recipe.')
        source = source.replace('cd ${DEPS}/rsvg\n', 'cd ${DEPS}/rsvg\nmkdir -p .cargo\ncp '
                                + shlex.quote(str(cargo_config)) + ' .cargo/config.toml\nexport CARGO_NET_OFFLINE=true\n', 1)
        (recipe / 'build/posix.sh').write_text(source)
        original_build = (recipe / 'build.sh').read_text()
        build = original_build.replace('$(brew --prefix)/bin/pkg-config', '$(command -v pkg-config)')
        (recipe / 'build.sh').write_text(build)
        changes = list(difflib.unified_diff(original.splitlines(True), source.splitlines(True),
                                          fromfile='upstream/build/posix.sh', tofile='offline/build/posix.sh'))
        changes += list(difflib.unified_diff(original_build.splitlines(True), build.splitlines(True),
                                           fromfile='upstream/build.sh', tofile='offline/build.sh'))
        (output / 'offline-acquisition.patch').write_text(''.join(changes))
        print(f'Prepared {len(crates)} verified crates and offline native source acquisition.')
        print('Build on the target Mac after installing the tools listed in README.md:')
        print('  cd ' + shlex.quote(str(recipe)))
        print('  RUSTUP_TOOLCHAIN=nightly-2026-09-27 ./build.sh darwin-arm64v8  # or darwin-x64')
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == '__main__':
    main()
