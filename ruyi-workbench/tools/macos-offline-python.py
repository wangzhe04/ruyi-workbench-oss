"""Build-time probes for the non-editable offline Python payload; no downloads."""
import argparse
import importlib.metadata
import json
import shlex
from pathlib import Path


def relocate_entrypoints(runtime):
    directory = Path(runtime) / 'bin'
    if not (directory / 'python').exists():
        (directory / 'python').symlink_to('python3')
    for distribution in importlib.metadata.distributions():
        for entry in distribution.entry_points:
            if entry.group != 'console_scripts':
                continue
            if Path(entry.name).name != entry.name or entry.name in ('python', 'python3', 'python3.12'):
                raise RuntimeError('Unsafe console entrypoint: ' + entry.name)
            code = ('import sys; from importlib.metadata import distribution; '
                    f'sys.argv[0]={entry.name!r}; '
                    f'entry=next(e for e in distribution({distribution.metadata["Name"]!r}).entry_points '
                    f'if e.group=="console_scripts" and e.name=={entry.name!r}); sys.exit(entry.load()())')
            target = directory / entry.name
            target.write_text('#!/bin/sh\nexec "${0%/*}/python3" -c ' + shlex.quote(code) + ' "$@"\n')
            target.chmod(0o755)


def licenses(runtime, output):
    records = []
    for distribution in sorted(importlib.metadata.distributions(), key=lambda item: item.metadata['Name'].lower()):
        files = list(distribution.files or [])
        notices = [str(file) for file in files if any(
            token in str(file).upper() for token in ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT'))]
        metadata = distribution.metadata
        record = {'name': metadata['Name'], 'version': distribution.version,
                  'license': metadata.get('License-Expression') or metadata.get('License'),
                  'notices': notices}
        if not notices:
            raise RuntimeError('No shipped license text for ' + record['name'])
        for file in files:
            resolved = Path(distribution.locate_file(file)).resolve()
            if not resolved.is_relative_to(Path(runtime).resolve()):
                raise RuntimeError('Distribution escapes bundled Python: ' + str(file))
        records.append(record)
    Path(output).write_text(json.dumps(records, indent=2) + '\n')


async def browser_notices(output):
    from playwright.async_api import async_playwright
    directory = Path(output)
    directory.mkdir()
    async with async_playwright() as playwright:
        # Use full Chromium in headless mode, matching production's explicit executable path.
        browser = await playwright.chromium.launch(executable_path=playwright.chromium.executable_path, headless=True)
        try:
            page = await browser.new_page()
            for name in ('credits', 'terms'):
                await page.goto('chrome://' + name, wait_until='load')
                text = await page.locator('body').inner_text()
                if len(text) < 100:
                    raise RuntimeError('Browser notices missing: ' + name)
                (directory / (name + '.html')).write_text(await page.content())
        finally:
            await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime')
    parser.add_argument('--licenses')
    parser.add_argument('--browser-notices')
    parser.add_argument('--entrypoints', action='store_true')
    arguments = parser.parse_args()
    if arguments.entrypoints:
        relocate_entrypoints(arguments.runtime)
    elif arguments.browser_notices:
        import asyncio
        asyncio.run(browser_notices(arguments.browser_notices))
    else:
        licenses(arguments.runtime, arguments.licenses)
