import pathlib,json,hashlib,lzma,tarfile,io,sys,zipfile
LOCK_SHA='fd3e23fd73698b064d92069ee43f9cfd513fe696d2643ff3afe2c92a4ca9797e'
REQUIRED={'codec_api.h','codec_app_def.h','codec_def.h','codec_ver.h','LICENSE'}
def validate(lock_path,source):
 lock_bytes=pathlib.Path(lock_path).read_bytes()
 if hashlib.sha256(lock_bytes).hexdigest()!=LOCK_SHA: raise ValueError('untrusted lock')
 lock=json.loads(lock_bytes); archive=lock['archive']; name=archive['name']
 if name!='openh264-headers-v2.5.0-supplement.tar.xz':raise ValueError('archive name')
 p=pathlib.Path(source)/name
 if p.is_symlink() or not p.is_file():raise ValueError('archive type')
 data=p.read_bytes()
 if len(data)!=archive['bytes'] or hashlib.sha256(data).hexdigest()!=archive['sha256']:raise ValueError('archive identity')
 return validate_contents(data,lock['files'])
def validate_contents(data,files):
 raw=lzma.decompress(data)
 if not raw:raise ValueError('empty xz')
 expected={r['name']:r for r in files}
 if set(expected)!=REQUIRED or len(files)!=len(REQUIRED):raise ValueError('lock members')
 seen=set()
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:') as t:
  for m in t:
   if not m.isfile() or m.name not in REQUIRED or m.name in seen:raise ValueError('member type')
   v=t.extractfile(m).read(); row=expected[m.name]
   if not v or len(v)!=row['bytes'] or hashlib.sha256(v).hexdigest()!=row['sha256']:raise ValueError('member integrity')
   seen.add(m.name)
 if seen!=REQUIRED:raise ValueError('missing headers')
 return True
def validate_legacy(source):
 p=pathlib.Path(source)/'opencv-windows-ffmpeg-sources-v2-local.zip'
 with zipfile.ZipFile(p) as z:data=z.read('upstream/archives/openh264-api-headers-v2.5.0.tar.xz')
 if hashlib.sha256(data).hexdigest()!='0040f94d11d0039505328a90b2ff48968db873e9e7967307631bf40ef5679275' or lzma.decompress(data)!=b'':raise ValueError('legacy header archive identity')
 return 'LEGACY_EMPTY_REQUIRES_SUPPLEMENT'
if __name__=='__main__':
 try:validate(sys.argv[1],sys.argv[2]);validate_legacy(sys.argv[3]);print('PASS_LEGACY_WITH_LOCKED_OPENH264_SUPPLEMENT')
 except Exception as e:print('REJECT_OPENH264_SUPPLEMENT: '+str(e),file=sys.stderr);sys.exit(1)
