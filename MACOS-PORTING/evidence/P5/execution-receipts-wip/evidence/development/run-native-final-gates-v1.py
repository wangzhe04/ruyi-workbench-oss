import json,pathlib,hashlib,subprocess,os,tempfile,time,datetime
raw=pathlib.Path('/tmp/ruyi-p5-receipts-evidence');work=pathlib.Path('/tmp/ruyi-p5-execution-receipts-worktree');freeze=raw/'native-capture-freeze-v1.json';f=json.loads(freeze.read_text());directory=raw/'development';results=[]
def bind():
 rows=[]
 for group in ['sources','artifacts']:
  for e in f[group]:
   p=pathlib.Path(e['path']);p=p if p.is_absolute() else work/p;b=p.read_bytes();rows.append({'group':group,'path':e['path'],'matched':hashlib.sha256(b).hexdigest()==e['sha256']})
 assert all(row['matched'] for row in rows)
 return rows
for label,command in [('syntax',['node','dev-harness/syntax-gate.js']),('build',['node','ruyi-workbench/app/build.js','--check']),('fast',['node','dev-harness/run-all.js','--fast','--parallel','4'])]:
 before=bind();iso=pathlib.Path(tempfile.mkdtemp(prefix='rg-',dir='/tmp'));env=dict(os.environ)
 for key in ['RUYI_HOME','WIN_CLAUDE_WORKBENCH_HOME','NODE_OPTIONS','RUYI_DESKTOP_EXECUTION_RECEIPTS']:env.pop(key,None)
 for key,sub in {'HOME':'h','USERPROFILE':'h','APPDATA':'a','LOCALAPPDATA':'l','TMPDIR':'t'}.items():
  p=iso/sub;p.mkdir(parents=True,exist_ok=True);env[key]=str(p)
 env.update(RUYI_REAL_HOME='/Users/jiming',PYTHONDONTWRITEBYTECODE='1');log=directory/('native-final-'+label+'-v1.log');assert not log.exists();start=time.monotonic()
 with log.open('wb') as out:child=subprocess.Popen(command,cwd=work,env=env,stdout=out,stderr=subprocess.STDOUT);code=child.wait()
 row={'label':label,'argv':command,'exitCode':code,'elapsed':time.monotonic()-start,'isolation':str(iso),'log':log.name,'before':before,'after':bind()};results.append(row);(directory/'native-final-gates-v1.json').write_text(json.dumps({'freeze':freeze.name,'freezeSha256':hashlib.sha256(freeze.read_bytes()).hexdigest(),'checks':results},indent=2)+'\n');print(label,code,row['elapsed'],flush=True)
 if code:raise SystemExit(code)
