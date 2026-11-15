import datetime,hashlib,json,os,pathlib,re,subprocess,tempfile,time,traceback
ROOT=pathlib.Path('/tmp/ruyi-p5-manual-worktree');OUT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/MACOS-PORTING/evidence/P5/manual/independent-offline-v6');MANUAL=OUT.parent
FREEZE=MANUAL/'development/sequence/current-source-v6.json';PREVIOUS=MANUAL/'development/sequence/current-source-v5.json';PRIOR_REPORT=MANUAL/'independent-offline-v5/report.json'
NODE='/Users/jiming/.local/bin/node';PYTHON='/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/.venv/bin/python'
DATA=json.loads(FREEZE.read_text());OLD=json.loads(PREVIOUS.read_text());PRIOR=json.loads(PRIOR_REPORT.read_text());CHECKS=[];RESULTS=[]
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(path):
 b=pathlib.Path(path).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(name,obj):(OUT/name).write_text(json.dumps(obj,indent=2)+'\n')
FREEZE_SHA=digest(FREEZE)['sha256'];PRIOR_SHA=digest(PRIOR_REPORT)['sha256']
assert PRIOR['status']=='passed_v5_offline_subset' and PRIOR['allExpectedExitCodesMatched']
assert set(DATA['files'])==set(OLD['files']) and len(DATA['files'])==34
changed=[p for p in DATA['files'] if DATA['files'][p]!=OLD['files'][p]]
assert changed==['dev-harness/macos-manual-record.e2e.js']
head=subprocess.run(['git','rev-parse','HEAD'],cwd=ROOT,capture_output=True,text=True,check=True).stdout.strip();assert head==OLD['baseCommit']==DATA['baseCommit']
status=subprocess.run(['git','status','--porcelain','-z','--untracked-files=all'],cwd=ROOT,capture_output=True,check=True).stdout.decode()
dirty=[entry[3:] for entry in status.split('\0') if entry];assert set(dirty)==set(DATA['files']),'Unbound worktree dirty files'
reuse_logs=[]
for step in PRIOR['steps']:
 if 'logDigest' in step:
  actual=digest(step['log']);assert actual==step['logDigest'],'Prior evidence changed'
  reuse_logs.append({'name':step['name'],'path':step['log'],'digest':actual})
artifacts=[]
for item in PRIOR['artifacts']:
 actual=digest(item['path']);assert actual=={k:item[k] for k in ['bytes','sha256']};artifacts.append(item)
BINDING={'at':stamp(),'previousManifest':{'path':str(PREVIOUS),'digest':digest(PREVIOUS)},'currentManifest':{'path':str(FREEZE),'digest':digest(FREEZE)},'previousReport':{'path':str(PRIOR_REPORT),'digest':digest(PRIOR_REPORT)},'sameBaselineCommit':head,'changedPaths':[{'path':p,'before':OLD['files'][p],'after':DATA['files'][p]} for p in changed],'unchangedFiles':[{'path':p,**DATA['files'][p]} for p in DATA['files'] if p not in changed],'unchangedCount':33,'dirtyPathsBoundByManifest':dirty,'reusedScope':{'nativeContracts':15,'pointerSubtypeCases':50,'pointerNativePythonFieldCases':15,'pythonSmokeTests':167,'pythonSkipped':0,'expectedNativeExitOne':20,'expectedMonitorExitSeventy':5,'productionVariablesIgnored':True,'sessionBootstrapQueuedAndOpenStdinCases':True,'limitations':'Reuse is based on identical frozen implementation/test fields and the same baseline for all other tracked sources. The sole changed file is the JS GUI diagnostic fixture; it receives fresh syntax/unit/static gates and subsequent independent GUI execution. This does not reuse or establish a physical demonstration or whole-phase acceptance.'},'priorLogsVerified':reuse_logs,'priorIndependentlyBuiltArtifacts':artifacts}
save('source-delta-binding.json',BINDING)
def check(label):
 rows=[{'path':p,'expected':e,'actual':digest(ROOT/p)} for p,e in DATA['files'].items()]
 for row in rows:row['matched']=row['actual']==row['expected']
 c={'label':label,'at':stamp(),'count':len(rows),'allMatched':all(r['matched'] for r in rows),'freezeUnchanged':digest(FREEZE)['sha256']==FREEZE_SHA,'reusedReportUnchanged':digest(PRIOR_REPORT)['sha256']==PRIOR_SHA,'files':rows};CHECKS.append(c);save('source-checks.json',CHECKS)
 assert c['count']==34 and c['allMatched'] and c['freezeUnchanged'] and c['reusedReportUnchanged'],'Source/evidence drift'
def run(name,command):
 check(name+'-before');base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='ruyi-v6-'));probe=subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True,text=True);assert probe.returncode==128
 values={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for value in values.values():pathlib.Path(value).mkdir()
 values.update({'RUYI_MACOS_AUTOMATION_HELPER':str(base/'absent-helper'),'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONPATH':str(ROOT/'mcp/ai-computer-control/src'),'PYTHONDONTWRITEBYTECODE':'1'})
 env=os.environ.copy();env.update(values);log=OUT/(name+'.txt');assert not log.exists(),'Refuse repeat gate';start=time.monotonic();started=stamp()
 with log.open('wb') as f:p=subprocess.run(command,cwd=ROOT,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=900)
 text=log.read_text(errors='replace');row={'name':name,'command':command,'startedAt':started,'elapsedSeconds':round(time.monotonic()-start,3),'exitCode':p.returncode,'environment':values,'tmpdirPathBytes':len(os.fsencode(values['TMPDIR'])),'outsideGit':probe.returncode==128,'log':str(log),'logDigest':digest(log)}
 if name=='fullunit':row['counts']={k:int(re.search(r'^ℹ '+k+r' (\d+)$',text,re.M).group(1)) for k in ['tests','suites','pass','fail','cancelled','skipped','todo']}
 if name=='fast':
  m=re.search(r'^# 汇总: (\d+) pass / (\d+) fail / (\d+) known-fail / (\d+) unexpected-pass / (\d+) flaky / (\d+) ran / (\d+) skipped',text,re.M)
  if m:row['counts']=dict(zip(['pass','fail','knownFail','unexpectedPass','flaky','ran','skipped'],map(int,m.groups())))
  n=re.search(r'^# unit 测试: ℹ tests (\d+) / ℹ pass (\d+) / ℹ fail (\d+) / ℹ skipped (\d+)',text,re.M)
  if n:row['nestedUnitPreflight']=dict(zip(['tests','pass','fail','skipped'],map(int,n.groups())))
  row['retryLines']=[s for s in text.splitlines() if '[retry]' in s or '[flaky:' in s]
 RESULTS.append(row);save('results.json',RESULTS);check(name+'-after');print(json.dumps({'gate':name,'exitCode':p.returncode,'seconds':row['elapsedSeconds'],'counts':row.get('counts')}),flush=True)
 assert p.returncode==0,'Gate failed '+name
try:
 check('initial')
 for name,command in [('syntax',[NODE,'dev-harness/syntax-gate.js']),('build-check',[NODE,'ruyi-workbench/app/build.js','--check']),('fullunit',[NODE,'--test','dev-harness/unit/*.test.js']),('fast',[NODE,'dev-harness/run-all.js','--fast'])]:run(name,command)
 check('final')
 save('report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':stamp(),'status':'passed_v6_offline_engineering_with_explicit_v5_reuse','freezePath':str(FREEZE),'freezeSha256':FREEZE_SHA,'frozenFiles':34,'sourceDeltaBinding':{'path':str(OUT/'source-delta-binding.json'),'digest':digest(OUT/'source-delta-binding.json')},'allSourceChecksMatched':all(c['allMatched'] and c['freezeUnchanged'] and c['reusedReportUnchanged'] for c in CHECKS),'checkpoints':len(CHECKS),'newCommands':4,'newCommandManualRetries':0,'nativePythonReexecuted':False,'reusedNativePythonEvidence':BINDING,'results':RESULTS,'phaseStatus':'in_progress','manualPhysicalFunctionalityAccepted':False,'history':'Prior GUI nested-cancellation wait timed out without pending receipts. v6 adds diagnostics; later diagnostic reruns do not establish the old timeout root cause. Historical development and harness interruptions remain preserved; no overall zero-rerun claim.','pending':['Independent GUI/App synthetic acceptance runs follow separately','Physical demonstrations v1/v2/v3 did not pass; Pressure-associated trackpad functionality remains open','Original P5 remaining audit/environment gates'],'claim':'Fresh v6 engineering gates plus explicitly bound v5 offline native/Python evidence support a partial implementation only, not full manual or P5 acceptance.'})
 print('V6 ENGINEERING PASS',flush=True)
except BaseException as e:
 traceback.print_exc()
 try:check('failure-final')
 except BaseException:traceback.print_exc()
 save('report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':stamp(),'status':'failed_or_blocked','error':repr(e),'results':RESULTS,'checks':CHECKS,'reuseBinding':BINDING,'phaseStatus':'in_progress','manualPhysicalFunctionalityAccepted':False});raise
