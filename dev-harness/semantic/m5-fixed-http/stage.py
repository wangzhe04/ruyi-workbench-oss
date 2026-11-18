"""Stage either reviewed v9 fixture with the tracked M5 repair in a fresh root."""
import argparse
import importlib.util
import json
import ntpath
import os
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
EVIDENCE = 'docs/optimization-plan/evidence/semantic-retrieval-20261116/'
CAPSULES = {
    's3c-m5-flush-denial-reviewed-20261118-r1': '64a24b93da28d38c5f149394270800aebb171af5ff6e48b340dea3b7ebace7ba',
    's3c-m5-fixed-http-reviewed-20261118-r1': 'a9040873eb0180c5027d05198725af070fc2b357ea703e71f23cab4ea0e8bf5e',
}
BASELINES = {
    'group': '7e490878870b4a4c24eb284aa3f54cbd8aeb0ac4aaeb3787067ed6740af19f4a',
    'human': '797c96b2cba0b0662a9911117c1d3b8707435798311f6c6edec848098ae0c952',
}
TRACKED = ('controller.cjs', 'controller-policy.cjs', 'keeper.candidate.ps1',
           'launcher.cjs', 'loopback-guard.cjs', 'flush-policy.cjs', 'business-policy.cjs',
           'business-launcher.cjs')

spec = importlib.util.spec_from_file_location('checkpoint', HERE.parent / 'checkpoint-handoff.py')
checkpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoint)


def row(path, raw):
    return {'path': str(path), 'bytes': len(raw), 'sha256': checkpoint.sha(raw)}


def overlay_product(files, root):
    paths = subprocess.run(
        ['git', 'ls-files', '-z', '--', 'ruyi-workbench/app', 'ruyi-workbench/package.json'],
        cwd=ROOT, check=True, capture_output=True,
    ).stdout.decode('utf-8').rstrip('\0').split('\0')
    source_prefix = 'ruyi-workbench/app/src/'
    manifest = json.loads(checkpoint.read(source_prefix + 'manifest.json'))
    paths.extend(source_prefix + (item if isinstance(item, str) else item['file'])
                 for item in manifest['modules'])
    for target in list(files):
        if target.is_relative_to(root / 'ruyi-workbench/app'):
            del files[target]
    for name in sorted(set(paths)):
        target = root.joinpath(*checkpoint.relative(name).parts)
        files[target] = checkpoint.read(name)
    source = files[root / source_prefix / '01w-work-data-native-publish.js']
    if checkpoint.sha(source) != 'b1f18f9053bd6499bbb859d99fde28476f77de6c6f70712a8dffdd6a6b5aed31':
        raise ValueError('Current flush source is not reviewed')
    for name in sorted(set(paths)):
        if files[root.joinpath(*checkpoint.relative(name).parts)] != checkpoint.read(name):
            raise ValueError('Current source changed during staging')

def stage(kind, name, node, windows, current_product, business_only):
    if os.name != 'nt':
        raise ValueError('Windows required')
    if not name.startswith('m5-fixed-http-') or not name.replace('-', '').isalnum():
        raise ValueError('Use a new output name prefixed m5-fixed-http-')
    named_business = name.startswith('m5-fixed-http-business-')
    if named_business != business_only or business_only and not current_product:
        raise ValueError('Business-only staging requires m5-fixed-http-business- name and --current-product')
    output = ROOT / 'output'
    if output.resolve(strict=True) != output:
        raise ValueError('Output must be canonical')
    root = output / name
    if root.exists() or root.is_symlink():
        raise ValueError('Case root must be new')

    refs = {}
    for capsule, pin in CAPSULES.items():
        m = EVIDENCE + capsule + '/manifest.json'
        for entry in checkpoint.manifest(m, pin)['records']:
            refs.setdefault(entry['rawSha256'], (m, entry))

    old_pin = BASELINES[kind]
    base = json.loads(checkpoint.decode(*refs[old_pin]))
    files, external = {}, []
    for entry in base['bindings']:
        old_path = entry['path']
        if old_path.startswith(base['root'] + '\\'):
            rel = ntpath.relpath(old_path, base['root'])
            path = checkpoint.relative(rel.replace('\\', '/'))
            if rel not in TRACKED:
                raw = checkpoint.decode(*refs[entry['sha256']])
                if len(raw) != entry['bytes']:
                    raise ValueError('Historical source length mismatch')
                files[root.joinpath(*path.parts)] = raw
        elif old_path == base['node']:
            external.append(node)
        elif old_path.startswith(base['systemRoot'] + '\\'):
            tool = windows.joinpath(*checkpoint.relative(
                ntpath.relpath(old_path, base['systemRoot']).replace('\\', '/')).parts)
            if tool.resolve(strict=True) != tool:
                raise ValueError('System tool must be canonical')
            external.append(tool)
        else:
            raise ValueError('Unexpected historical tool input')
    if current_product:
        overlay_product(files, root)
    bindings = [row(path, path.read_bytes()) for path in external]
    case_output = root / 'case-output'
    home = root / 'case-home'
    files[case_output / 'OWNER.json'] = b'{"owner":"m5-loopback-case","synthetic":true}\n'
    files.update({root / name: (HERE / name).read_bytes() for name in TRACKED})
    bindings += [row(path, raw) for path, raw in files.items()]
    powershell = windows / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if str(powershell) not in {r['path'] for r in bindings}:
        raise ValueError('Canonical PowerShell binding missing')
    contract = {**base, 'baselineSha256': old_pin,
                'productSource': 'current-working-tree' if current_product else 'historical-v9',
                'node': str(node),
                'powershell': str(powershell), 'systemRoot': str(windows),
                'root': str(root), 'output': str(case_output), 'home': str(home),
                'guard': str(root / 'loopback-guard.cjs'), 'bindings': bindings}
    if business_only:
        contract.update(status='FROZEN_M5_HTTP_BUSINESS_ONLY',
                        scope='Current-product business assertions and guard closure in an owned Job',
                        limits=['Synthetic loopback transport only; no real account/platform.',
                                'Group requires one fresh server; human requires all nine independent servers.',
                                'Natural outer Job empty and zero limit terminations required.',
                                'Per-process kernel birth, image and retirement qualification not run.'])
    root.mkdir()
    for target, raw in files.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(raw)
    for subdir in ('tmp', 'local', 'roaming'):
        (home / subdir).mkdir(parents=True)
    raw = (json.dumps(contract, indent=2) + '\n').encode()
    file = case_output / 'freeze.json'
    with file.open('xb') as stream:
        stream.write(raw)
    print(json.dumps({'fixture': contract['fixture'], 'path': str(file),
                      'sha256': checkpoint.sha(raw), 'bindings': len(bindings),
                      'executed': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=BASELINES)
    parser.add_argument('name', help='new direct child of output')
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--windows', required=True, type=Path)
    parser.add_argument('--current-product', action='store_true', help='use the current tracked app tree and manifest modules')
    parser.add_argument('--business-only', action='store_true', help='stage a distinct business-only lane')
    args = parser.parse_args()
    stage(args.kind, args.name, args.node.resolve(strict=True), args.windows.resolve(strict=True), args.current_product, args.business_only)
