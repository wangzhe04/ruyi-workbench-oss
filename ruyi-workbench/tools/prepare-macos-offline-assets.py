#!/usr/bin/env python3
"""Prepare pinned build assets on a connected workstation, separately from offline assembly.

Python 3.14+ is used only here to read the standalone Python build's Zstandard license archive.
The shipped interpreter remains CPython 3.12. --download explicitly enables network access;
without it all archives/wheels must already exist in --cache.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tarfile
import urllib.request
import zipfile


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def cached_file(cache, filename, expected, url, download):
    file = cache / filename
    if not file.exists():
        if not download:
            raise RuntimeError('Missing cached input: ' + str(file) + '; prepare with --download on a connected workstation')
        temporary = file.with_name(file.name + '.partial')
        print('Downloading ' + filename, flush=True)
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        if digest(temporary) != expected:
            raise RuntimeError('Downloaded hash mismatch: ' + filename)
        temporary.rename(file)
    if digest(file) != expected:
        raise RuntimeError('Cached hash mismatch: ' + filename)
    return file


def unzip(file, destination):
    with zipfile.ZipFile(file) as archive:
        links = []
        for item in archive.infolist():
            relative = PurePosixPath(item.filename)
            if relative.is_absolute() or '..' in relative.parts or '\\' in item.filename:
                raise RuntimeError('Unsafe ZIP member: ' + item.filename)
            target = destination.joinpath(*relative.parts)
            mode = item.external_attr >> 16
            target.parent.mkdir(parents=True, exist_ok=True)
            if item.is_dir():
                target.mkdir(exist_ok=True)
            elif stat.S_ISLNK(mode):
                link = archive.read(item).decode('utf-8')
                if os.path.isabs(link) or not (target.parent / link).resolve().is_relative_to(destination.resolve()):
                    raise RuntimeError('Unsafe ZIP symlink: ' + item.filename)
                links.append((target, link))
            else:
                with archive.open(item) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(mode & 0o777 or 0o644)
        for target, link in links:
            target.symlink_to(link)


def prepare(arguments):
    repo = Path(__file__).resolve().parents[2]
    lock = json.loads((repo / 'MACOS-PORTING/dependencies/macos-offline-arm64.assets.json').read_text())
    cache = Path(arguments.cache).resolve()
    output = Path(arguments.output).resolve()
    if output.exists():
        raise RuntimeError('Output already exists; use a new directory')
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True)
    try:
        for component in lock['components']:
            source = component['sources'][0]
            name = {'node': 'node.tar.gz', 'python': 'python.tar.gz', 'ripgrep': 'ripgrep.tar.gz',
                    'chromium': 'chromium.zip', 'python-notices': 'python-full.tar.zst'}[component['id']]
            file = cached_file(cache, name, source['sha256'], source['url'], arguments.download)
            if component['id'] == 'chromium':
                destination = output / component['path']
                destination.mkdir()
                unzip(file, destination)
            elif component['id'] == 'python-notices':
                destination = output / component['path']
                destination.mkdir()
                with tarfile.open(file, mode='r|zst') as archive:
                    for item in archive:
                        if item.isfile() and (item.name.startswith('python/licenses/') or item.name == 'python/PYTHON.json'):
                            (destination / PurePosixPath(item.name).name).write_bytes(archive.extractfile(item).read())
            else:
                destination = output / component['path'].split('/')[0]
                destination.mkdir()
                with tarfile.open(file) as archive:
                    archive.extractall(destination, filter='data')
        wheel_output = output / lock['wheelsPath']
        wheel_output.mkdir(parents=True)
        for wheel in lock['wheels']:
            file = cached_file(cache, wheel['filename'], wheel['sha256'], wheel['url'], arguments.download)
            shutil.copyfile(file, wheel_output / wheel['filename'])
        # The offline assembler independently checks every component tree and wheel against the lock.
        print('Prepared ' + str(output), flush=True)
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--download', action='store_true')
    prepare(parser.parse_args())
