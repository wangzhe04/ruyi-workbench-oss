import datetime,hashlib,json,os,pathlib,subprocess,tempfile,time
ROOT=pathlib.Path('/tmp/ruyi-p5-manual-worktree')
OUT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/MACOS-PORTING/evidence/P5/manual/independent-offline-v5')
FREEZE=OUT.parent/'development/sequence/current-source-v5.json'
frozen=json.loads(FREEZE.read_text());freeze_sha=hashlib.sha256(FREEZE.read_bytes()).hexdigest();checks=[];results=[]
def digest(path):
 b=pathlib.Path(path).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(name,obj):(OUT/name).write_text(json.dumps(obj,indent=2)+'\n')
def check(label):
 rows=[{'path':p,'expected':e,'actual':digest(ROOT/p)} for p,e in frozen['files'].items()]
 for x in rows:x['matched']=x['actual']==x['expected']
 record={'label':label,'count':len(rows),'files':rows,'allMatched':all(x['matched'] for x in rows),'freezeUnchanged':digest(FREEZE)['sha256']==freeze_sha};checks.append(record);save('queued-source-checks.json',checks)
 assert record['count']==34 and record['allMatched'] and record['freezeUnchanged']
report=json.loads((OUT/'report.json').read_text());assert report['status']=='passed_v5_offline_subset'
helper=pathlib.Path(next(a['path'] for a in report['artifacts'] if a['mode']=='testing'))
assert digest(helper)=={k:next(a for a in report['artifacts'] if a['mode']=='testing')[k] for k in ['bytes','sha256']}
check('initial')
for fault in ['create','register']:
 name='session-testing-queued-'+fault;check(name+'-before');base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='ruyi-v5-q-'))
 probe=subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True,text=True);assert probe.returncode==128
 vals={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for v in vals.values():pathlib.Path(v).mkdir()
 vals['RUYI_TEST_SESSION_MONITOR_FAILURE']=fault;env=os.environ.copy();env.update(vals)
 request={'version':1,'op':'window.list','id':71};frame=(json.dumps(request)+'\n').encode()
 path=OUT/(name+'.json');assert not path.exists(),'Refuse duplicate queued bootstrap scenario'
 readfd,writefd=os.pipe();assert os.write(writefd,frame)==len(frame)
 start=time.monotonic();cmd=[str(helper),'--input-session'];p=None
 try:
  p=subprocess.Popen(cmd,cwd=str(ROOT),env=env,stdin=readfd,stdout=subprocess.PIPE,stderr=subprocess.PIPE);os.close(readfd);readfd=None
  p.wait(timeout=5);pipe_open_at_exit=os.fstat(writefd) is not None
  stdout=p.stdout.read();stderr=p.stderr.read()
 finally:
  if p is not None and p.poll() is None:
   p.terminate()
   try:p.wait(timeout=2)
   except subprocess.TimeoutExpired:p.kill();p.wait(timeout=2)
  if readfd is not None:os.close(readfd)
  os.close(writefd)
 row={'name':name,'command':cmd,'request':request,'framePrequeuedBeforeSpawn':True,'frameBytes':len(frame),'stdinWriterOpenAtExit':pipe_open_at_exit,'exitCode':p.returncode,'expectedExitCode':70,'stdout':stdout.decode(errors='replace'),'stderr':stderr.decode(errors='replace'),'elapsedSeconds':round(time.monotonic()-start,3),'environment':vals,'tmpdirPathBytes':len(os.fsencode(vals['TMPDIR'])),'isolationRootOutsideGit':probe.returncode==128}
 save(name+'.json',row);results.append(row);save('queued-bootstrap-results.json',results);check(name+'-after')
 assert p.returncode==70 and pipe_open_at_exit and not stdout,'Queued bootstrap contract failed'
 print(json.dumps({'name':name,'exitCode':p.returncode,'framePrequeued':True,'stdinWriterOpenAtExit':pipe_open_at_exit}),flush=True)
check('final')
report['queuedBootstrapSupplement']={'scope':'Two additional queued-frame bootstrap scenarios requested after the idle bootstrap checks had already run; independent new cases, no retries or log replacement. window.list JSONL bytes were written into each stdin pipe before exec; parent kept the writer open until the child naturally exited.','results':results,'checkpoints':len(checks),'allSourceChecksMatched':all(x['allMatched'] and x['freezeUnchanged'] for x in checks)}
report['expectedMonitorNegativeExitSeventyIncludingSupplement']=report['expectedMonitorNegativeExitSeventy']+len(results)
report['totalAcceptanceCommandInvocationsIncludingSupplement']=len(report['steps'])+len(results)
save('report.json',report)
