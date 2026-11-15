"""Read arm64 Mach-O deployment targets in prepared P3 wheels/browser; never run them."""
import argparse, hashlib, json, mmap, struct, zipfile
from pathlib import Path

MAGIC = {b'\xcf\xfa\xed\xfe': ('<', 32), b'\xce\xfa\xed\xfe': ('<', 28),
         b'\xfe\xed\xfa\xcf': ('>', 32), b'\xfe\xed\xfa\xce': ('>', 28)}
FAT = {b'\xca\xfe\xba\xbe': ('>', 20, False), b'\xbe\xba\xfe\xca': ('<', 20, False),
       b'\xca\xfe\xba\xbf': ('>', 32, True), b'\xbf\xba\xfe\xca': ('<', 32, True)}
ARM64 = 0x0100000c

def version(value):
    return [value >> 16, (value >> 8) & 255, value & 255]

def inspect(data, base=0, end=None):
    end = len(data) if end is None else end
    if not 0 <= base <= end <= len(data) or end-base < 4:
        raise ValueError('invalid Mach-O slice bounds')
    magic = bytes(data[base:base+4])
    if magic in FAT:
        endian, size, wide = FAT[magic]
        if end-base < 8: raise ValueError('truncated fat header')
        count = struct.unpack_from(endian+'I', data, base+4)[0]
        if not 0 < count <= 100 or 8+count*size > end-base:
            raise ValueError('invalid fat architecture table')
        table_end = base+8+count*size
        out = []
        for i in range(count):
            at = base+8+i*size
            cpu = struct.unpack_from(endian+'I', data, at)[0]
            offset, length = struct.unpack_from(endian+('QQ' if wide else 'II'), data, at+8)
            start, stop = base+offset, base+offset+length
            if length < 4 or start < table_end or stop > end:
                raise ValueError('invalid fat slice bounds')
            if cpu == ARM64:
                if bytes(data[start:start+4]) not in MAGIC:
                    raise ValueError('fat arm64 slice is not a thin Mach-O')
                targets = inspect(data, start, stop)
                if not targets: raise ValueError('fat arm64 slice CPU mismatch')
                out += targets
        return out
    if magic not in MAGIC: return []
    endian, header = MAGIC[magic]
    if end-base < header: raise ValueError('truncated Mach-O header')
    cpu = struct.unpack_from(endian+'I', data, base+4)[0]
    if cpu != ARM64: return []
    count, commands_size = struct.unpack_from(endian+'II', data, base+16)
    if count > 10000 or count*8 > commands_size:
        raise ValueError('invalid command count')
    at = base+header
    commands_end = at+commands_size
    if commands_end > end: raise ValueError('load commands exceed Mach-O slice')
    versions = []
    for _ in range(count):
        if at+8 > commands_end: raise ValueError('truncated load command header')
        command, size = struct.unpack_from(endian+'II', data, at)
        if size < 8 or at+size > commands_end: raise ValueError('invalid load command size')
        if command == 0x32:
            if size < 24: raise ValueError('truncated build version command')
            tools = struct.unpack_from(endian+'I', data, at+20)[0]
            if 24+8*tools > size: raise ValueError('truncated build version tool table')
            platform, minimum = struct.unpack_from(endian+'II', data, at+8)
            if platform == 1: versions.append(version(minimum))
        elif command == 0x24:
            if size < 16: raise ValueError('truncated minimum version command')
            versions.append(version(struct.unpack_from(endian+'I', data, at+8)[0]))
        at += size
    if at != commands_end: raise ValueError('load command sizes do not match sizeofcmds')
    if not versions: raise ValueError('arm64 binary has no macOS deployment target')
    return versions

parser = argparse.ArgumentParser()
parser.add_argument('--wheelhouse', type=Path, required=True)
parser.add_argument('--browser-root', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
required_browser_paths = [
    'chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/156.0.8078.4/Google Chrome for Testing Framework',
]
report = {'target': [14,0,0], 'scope': 'Static arm64 Mach-O load commands only; not macOS14 execution or signed release validation',
          'wheels': [], 'browser': [], 'errors': []}
if not args.wheelhouse.is_dir(): raise SystemExit('missing wheelhouse')
if not (args.browser_root/'chromium-1248').is_dir(): raise SystemExit('missing required Chromium cache')
for wheel in sorted(args.wheelhouse.glob('*.whl')):
    record = {'wheel': wheel.name, 'sha256': hashlib.sha256(wheel.read_bytes()).hexdigest(), 'arm64Binaries': []}
    with zipfile.ZipFile(wheel) as archive:
        for entry in archive.infolist():
            if entry.is_dir() or entry.file_size < 4: continue
            with archive.open(entry) as item: magic = item.read(4)
            if magic not in MAGIC and magic not in FAT: continue
            try:
                targets = inspect(archive.read(entry))
                if targets: record['arm64Binaries'].append({'path': entry.filename, 'minimums': targets})
            except Exception as exc: report['errors'].append({'wheel':wheel.name,'path':entry.filename,'error':str(exc)})
    report['wheels'].append(record)
for root in ('chromium-1248', 'ffmpeg-1013'):
    for path in sorted((args.browser_root/root).rglob('*')):
        if not path.is_file() or path.is_symlink() or path.stat().st_size < 4: continue
        with path.open('rb') as stream:
            magic = stream.read(4)
            if magic not in MAGIC and magic not in FAT: continue
            try:
                with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
                    targets = inspect(data)
                    digest = hashlib.sha256(data).hexdigest()
                if targets: report['browser'].append({'path':str(path.relative_to(args.browser_root)), 'minimums':targets, 'bytes':path.stat().st_size, 'sha256':digest})
            except Exception as exc: report['errors'].append({'path':str(path),'error':str(exc)})
observed = {entry['path'] for entry in report['browser']}
for required in required_browser_paths:
    if required not in observed: report['errors'].append({'path':required,'error':'required arm64 browser binary not inspected'})
entries = [x for w in report['wheels'] for x in w['arm64Binaries']] + report['browser']
report['overTarget'] = [x for x in entries if any(v > report['target'] for v in x['minimums'])]
report['wheelCount'] = len(report['wheels'])
report['arm64BinaryCount'] = len(entries)
report['maxDeclaredMinimum'] = max((v for x in entries for v in x['minimums']), default=None)
report['staticDeploymentCheckPassed'] = bool(report['wheels']) and bool(report['browser']) and not report['errors'] and not report['overTarget']
args.out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ('wheelCount','arm64BinaryCount','maxDeclaredMinimum','staticDeploymentCheckPassed','errors','overTarget')},ensure_ascii=False))
raise SystemExit(0 if report['staticDeploymentCheckPassed'] else 1)
