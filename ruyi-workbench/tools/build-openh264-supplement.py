#!/usr/bin/env python3
"""Build a locked OpenH264 header supplement; no network or binary execution."""
import argparse,hashlib,io,json,lzma,pathlib,tarfile
LOCK_SHA='fd3e23fd73698b064d92069ee43f9cfd513fe696d2643ff3afe2c92a4ca9797e'
REQUIRED={'codec_api.h','codec_app_def.h','codec_def.h','codec_ver.h','LICENSE'}
def digest(data):return hashlib.sha256(data).hexdigest()
def build(lock_path,header_root,destination):
 lock_bytes=pathlib.Path(lock_path).read_bytes()
 if digest(lock_bytes)!=LOCK_SHA:raise ValueError('untrusted lock')
 lock=json.loads(lock_bytes);rows=lock['files'];names=[row['name'] for row in rows]
 if len(names)!=5 or set(names)!=REQUIRED or lock['archive']['name']!='openh264-headers-v2.5.0-supplement.tar.xz':raise ValueError('lock shape')
 root=pathlib.Path(header_root)
 if root.is_symlink() or not root.is_dir():raise ValueError('header root')
 buf=io.BytesIO()
 with tarfile.open(fileobj=buf,mode='w',format=tarfile.USTAR_FORMAT) as archive:
  for row in sorted(rows,key=lambda item:item['name']):
   file=root/row['name']
   if file.is_symlink() or not file.is_file():raise ValueError('header type')
   data=file.read_bytes()
   if not data or len(data)!=row['bytes'] or digest(data)!=row['sha256']:raise ValueError('header integrity')
   info=tarfile.TarInfo(row['name']);info.size=len(data);info.mtime=0;info.uid=info.gid=0;info.mode=0o644;archive.addfile(info,io.BytesIO(data))
 data=lzma.compress(buf.getvalue(),format=lzma.FORMAT_XZ)
 if len(data)!=lock['archive']['bytes'] or digest(data)!=lock['archive']['sha256']:raise ValueError('archive identity')
 dest=pathlib.Path(destination)
 with dest.open('xb') as out:out.write(data)
 return {'bytes':len(data),'sha256':digest(data)}
def main():
 p=argparse.ArgumentParser();p.add_argument('--lock',required=True);p.add_argument('--header-root',required=True);p.add_argument('--destination',required=True);a=p.parse_args();print(json.dumps(build(a.lock,a.header_root,a.destination)))
if __name__=='__main__':main()
