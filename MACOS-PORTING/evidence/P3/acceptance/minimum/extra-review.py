from pathlib import Path
import struct,json,hashlib
p=Path('MACOS-PORTING/probes/audit-macos-minimum.py')
ns={};exec(p.read_text().split('parser = argparse.ArgumentParser()')[0],ns)
ARM64=0x0100000c
valid=b'\xcf\xfa\xed\xfe'+struct.pack('<IIIIIII',ARM64,0,6,1,24,0,0)+struct.pack('<IIIIII',0x32,24,1,13<<16,27<<16,0)
def fat(data,offset=4096):
 return (b'\xca\xfe\xba\xbe'+struct.pack('>I',1)+struct.pack('>IIIII',ARM64,0,offset,len(data),12)).ljust(max(28,offset),b'\0')+data
bad_cpu=valid[:4]+struct.pack('<I',0x01000007)+valid[8:]
padded=bytearray(valid+b'\0'*8);struct.pack_into('<I',padded,20,32)
tools=bytearray(valid+struct.pack('<II',3,123));struct.pack_into('<I',tools,20,32);struct.pack_into('<I',tools,36,32);struct.pack_into('<I',tools,52,1)
cases=[('truncated-thin-header',valid[:24],False),('truncated-fat-header',b'\xca\xfe\xba\xbe',False),('truncated-fat-table',b'\xca\xfe\xba\xbe'+struct.pack('>I',1),False),('fat-table-overlap',fat(valid,0),False),('fat-arm64-cpu-mismatch',fat(bad_cpu),False),('fat-nested-fat',fat(fat(valid)),False),('fat-arm64-not-mach-o',fat(b'abcd'),False),('commands-size-unconsumed-padding',padded,False),('valid-build-tool-table',tools,True)]
results=[]
for name,data,expected in cases:
 try:targets=ns['inspect'](data);passed=True;error=None
 except Exception as exc:targets=None;passed=False;error=str(exc)
 results.append({'fixture':name,'expected_parse':expected,'parsed':passed,'targets':targets,'error':error,'matched':passed==expected})
r={'source_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'results':results,'allMatched':all(x['matched'] for x in results)}
Path('/tmp/ruyi-p3-minimum-extra-review.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
