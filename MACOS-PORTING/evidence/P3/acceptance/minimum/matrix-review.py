from pathlib import Path
import tempfile,struct,zipfile,subprocess,sys,json,hashlib
ARM64=0x0100000c
probe=Path('MACOS-PORTING/probes/audit-macos-minimum.py').resolve()
def thin(endian='<',kind='build',minimum=13,declared=None,ncmds=1,cmdsize=None,ntools=0):
 magic=b'\xcf\xfa\xed\xfe' if endian=='<' else b'\xfe\xed\xfa\xcf'
 if kind=='build':command=struct.pack(endian+'IIIIII',0x32,cmdsize if cmdsize is not None else 24,1,minimum<<16,27<<16,ntools)
 else:command=struct.pack(endian+'IIII',0x24,cmdsize if cmdsize is not None else 16,minimum<<16,27<<16)
 return magic+struct.pack(endian+'IIIIIII',ARM64,0,6,ncmds,len(command) if declared is None else declared,0,0)+command
valid=thin()
def fat(data,endian='>',wide=False,size=None):
 magic={(False,'>'):b'\xca\xfe\xba\xbe',(False,'<'):b'\xbe\xba\xfe\xca',(True,'>'):b'\xca\xfe\xba\xbf',(True,'<'):b'\xbf\xba\xfe\xca'}[wide,endian]
 entry=struct.pack(endian+('IIQQII' if wide else 'IIIII'),ARM64,0,4096,len(data) if size is None else size,12,*([0] if wide else []))
 return (magic+struct.pack(endian+'I',1)+entry).ljust(4096,b'\0')+data
cases=[('valid-thin-little',valid,True),('valid-thin-big',thin('>'),True),('valid-legacy',thin(kind='legacy'),True),('valid-fat32',fat(valid),True),('valid-fat64',fat(valid,wide=True),True),('valid-fat64-little',fat(valid,endian='<',wide=True),True),('short-command',thin(declared=8,cmdsize=8),False),('short-legacy-command',thin(kind='legacy',declared=8,cmdsize=8),False),('short-command-region',thin(declared=8),False),('short-fat-slice',fat(valid,size=32),False),('out-of-file-fat-slice',fat(valid,size=len(valid)+1),False),('truncated-tool-table',thin(ntools=1),False),('excess-command-count',thin(ncmds=2),False),('over-target-15',thin(minimum=15),False)]
with tempfile.TemporaryDirectory(prefix='p3-minimum-matrix-') as d:
 root=Path(d);wheels=root/'wheels';wheels.mkdir();browser=root/'browser'/'chromium-1248';browser.mkdir(parents=True)
 for rel in ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/156.0.8078.4/Google Chrome for Testing Framework']:
  dest=browser/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(valid)
 results=[]
 for name,data,expected in cases:
  wheel=wheels/'review-1.0-cp312-cp312-macosx_11_0_arm64.whl'
  with zipfile.ZipFile(wheel,'w') as z:z.writestr('review.dylib',data)
  out=root/(name+'.json')
  r=subprocess.run([sys.executable,str(probe),'--wheelhouse',str(wheels),'--browser-root',str(browser.parent),'--out',str(out)],capture_output=True,text=True,timeout=10)
  report=json.loads(out.read_text())
  results.append({'fixture':name,'expected_pass':expected,'probe_exit':r.returncode,'probe_passed':report['staticDeploymentCheckPassed'],'matched':report['staticDeploymentCheckPassed']==expected and r.returncode==(0 if expected else 1),'probe_errors':report['errors'],'overTarget':report['overTarget']})
 report={'probe_sha256':hashlib.sha256(probe.read_bytes()).hexdigest(),'results':results,'allMatched':all(x['matched'] for x in results)}
 print(json.dumps(report,ensure_ascii=False,indent=2))
 Path('/tmp/ruyi-p3-minimum-matrix-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
