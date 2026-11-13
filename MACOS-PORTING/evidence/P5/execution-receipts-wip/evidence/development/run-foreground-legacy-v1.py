import os,subprocess,tempfile,pathlib,json,hashlib,datetime,time
root=pathlib.Path('/tmp/ruyi-p5-receipts-evidence/development');work=pathlib.Path('/tmp/ruyi-p5-execution-receipts-worktree');freeze=pathlib.Path('/tmp/ruyi-p5-receipts-evidence/foreground-subagent-freeze-v3.json');f=json.loads(freeze.read_text());checks=[]
def binding():
 rows=[]
 for group in ['sources','artifacts']:
  for e in f[group]:
   p=pathlib.Path(e['path']);p=p if p.is_absolute() else work/p
   sha=hashlib.sha256(p.read_bytes()).hexdigest();rows.append({'group':group,'path':e['path'],'matched':sha==e['sha256']})
 assert all(r['matched'] for r in rows)
 return rows
for name in ['agent-resource-wait-stop','subagent-thinking-continuity','subagent-compaction-parity','agent-node-wrapup','agent-parent-heartbeat']:
 iso=pathlib.Path(tempfile.mkdtemp(prefix='rl-',dir='/tmp'));env=dict(os.environ)
 for key in ['RUYI_HOME','WIN_CLAUDE_WORKBENCH_HOME','RUYI_DESKTOP_EXECUTION_RECEIPTS','NODE_OPTIONS']:env.pop(key,None)
 for key,sub in {'HOME':'h','USERPROFILE':'h','LOCALAPPDATA':'a/local','APPDATA':'a/roaming','TMPDIR':'t'}.items():
  p=iso/sub;p.mkdir(parents=True,exist_ok=True);env[key]=str(p)
 env.update(RUYI_REAL_HOME='/Users/jiming',PYTHONDONTWRITEBYTECODE='1')
 log=root/('foreground-legacy-'+name+'-v1.log');assert not log.exists();before=binding();start=time.monotonic()
 with log.open('wb') as out:
  child=subprocess.Popen(['node','dev-harness/'+name+'.e2e.js'],cwd=work,env=env,stdout=out,stderr=subprocess.STDOUT)
  code=child.wait()
 text=log.read_text(errors='replace');after=binding();row={'name':name,'log':str(log),'iso':str(iso),'exitCode':code,'elapsedSeconds':time.monotonic()-start,'before':before,'after':after,'pass':sum(l.startswith('PASS ') for l in text.splitlines()),'fail':sum(l.startswith('FAIL ') for l in text.splitlines()),'allPass':'E2E: ALL PASS' in text,'attempt':1,'featureDefault':'off','scope':'Real isolated workbench with scripted providers; no native/GUI. Fixture owns data root; no outer RUYI_HOME override.'};checks.append(row);(root/'foreground-legacy-summary-v1.json').write_text(json.dumps({'schema':1,'freeze':freeze.name,'checks':checks,'status':'running' if code==0 else 'failed'},indent=2)+'\n');print(name,code,row['pass'],row['fail'],row['allPass'],flush=True)
 if code or not row['allPass']:raise SystemExit(1)
(root/'foreground-legacy-summary-v1.json').write_text(json.dumps({'schema':1,'freeze':freeze.name,'checks':checks,'status':'passed'},indent=2)+'\n')
