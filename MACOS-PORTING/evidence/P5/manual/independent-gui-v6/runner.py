import datetime,hashlib,json,os,pathlib,re,subprocess,tempfile,time,traceback
ROOT=pathlib.Path('/tmp/ruyi-p5-manual-worktree');OUT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/MACOS-PORTING/evidence/P5/manual/independent-gui-v6');MANUAL=OUT.parent
FREEZE=MANUAL/'development/sequence/current-source-v6.json';ENGINEERING=MANUAL/'independent-offline-v6/report.json';V5=MANUAL/'independent-offline-v5/report.json'
NODE='/Users/jiming/.local/bin/node';PYTHON='/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/.venv/bin/python'
APP=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/dist/Ruyi.app');CHECKS=[];RESULTS=[]
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(path):
 b=pathlib.Path(path).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(path,obj):pathlib.Path(path).write_text(json.dumps(obj,indent=2)+'\n')
DATA=json.loads(FREEZE.read_text());FREEZE_SHA=digest(FREEZE)['sha256'];engineer=json.loads(ENGINEERING.read_text());assert engineer['status']=='passed_v6_offline_engineering_with_explicit_v5_reuse'
prior=json.loads(V5.read_text());item=next(x for x in prior['artifacts'] if x['mode']=='normal');HELPER=pathlib.Path(item['path']);assert digest(HELPER)=={k:item[k] for k in ['bytes','sha256']}
APPFILES=[APP/'Contents/MacOS/RuyiDesktop',APP/'Contents/Info.plist',APP/'Contents/_CodeSignature/CodeResources'];ARTIFACTS={str(p):digest(p) for p in [HELPER,*APPFILES]}
def check(label):
 rows=[{'path':p,'expected':e,'actual':digest(ROOT/p)} for p,e in DATA['files'].items()]
 for row in rows:row['matched']=row['expected']==row['actual']
 record={'label':label,'at':now(),'files':rows,'allMatched':all(r['matched'] for r in rows),'freezeUnchanged':digest(FREEZE)['sha256']==FREEZE_SHA,'artifactsUnchanged':all(digest(p)==expected for p,expected in ARTIFACTS.items())};CHECKS.append(record);save(OUT/'source-artifact-checks.json',CHECKS)
 assert len(rows)==34 and record['allMatched'] and record['freezeUnchanged'] and record['artifactsUnchanged'],'Frozen source/artifact drift'
def table():
 raw=subprocess.run(['ps','-axo','pid=,ppid=,lstart=,command='],capture_output=True,text=True,check=True).stdout
 result=[]
 for line in raw.splitlines():
  parts=line.split(None,7)
  if len(parts)==8:
   result.append({'pid':int(parts[0]),'ppid':int(parts[1]),'birth':' '.join(parts[2:7]),'command':parts[7]})
 return result

def verify_signature(path,deep=False):
 cmd=['/usr/bin/codesign','--verify',*(['--deep'] if deep else []),'--strict',str(path)]
 p=subprocess.run(cmd,capture_output=True,text=True)
 result={'command':cmd,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr};assert p.returncode==0,'Artifact signature verification failed';return result

def run(name,script):
 directory=OUT/name;directory.mkdir(exist_ok=True);log=directory/'e2e.txt';assert not log.exists(),'Refuse test scenario repetition'
 check(name+'-before');base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='ruyi-g6-'));probe=subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True,text=True);assert probe.returncode==128
 values={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for v in values.values():pathlib.Path(v).mkdir()
 values.update({'RUYI_REAL_HOME':'/Users/jiming','RUYI_ACC_PYTHON':PYTHON,'RUYI_MACOS_AUTOMATION_HELPER':str(HELPER),'RUYI_P5_MANUAL_HELPER':str(HELPER),'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONPATH':str(ROOT/'mcp/ai-computer-control/src'),'PYTHONDONTWRITEBYTECODE':'1'})
 if name=='gui':values.update({'RUYI_P5_MANUAL_REQUIRED':'1','RUYI_P5_MANUAL_EVIDENCE':str(directory)})
 else:values.update({'RUYI_P5_APP_MANUAL':'1','RUYI_P5_EVIDENCE':str(directory),'RUYI_DESKTOP_TEST_APP':str(APP)})
 env=os.environ.copy()
 for key in ['RUYI_TEST_SESSION_MONITOR_FAILURE','RUYI_P5_APP_COMPOSED','RUYI_P5_APP_RECORD','RUYI_P5_APP_VISUAL','RUYI_P5_APP_AX','RUYI_P5_APP_PASTE','RUYI_P5_APP_EXIT_FAILURE','RUYI_P5_APP_MANUAL','RUYI_P5_MANUAL_REQUIRED','RUYI_P5_MANUAL_EVIDENCE','RUYI_P5_EVIDENCE']:env.pop(key,None)
 env.update(values);command=[NODE,script];started=now();start=time.monotonic();observed={}
 with log.open('wb') as stream:
  child=subprocess.Popen(command,cwd=ROOT,env=env,stdout=stream,stderr=subprocess.STDOUT)
  save(directory/'invocation.json',{'command':command,'pid':child.pid,'startedAt':started,'cwd':str(ROOT),'environment':values,'tmpdirPathBytes':len(os.fsencode(values['TMPDIR']))})
  while child.poll() is None:
   current=table();wanted={child.pid};changed=True
   while changed:
    changed=False
    for row in current:
     if row['ppid'] in wanted and row['pid'] not in wanted:wanted.add(row['pid']);changed=True
   for row in current:
    if row['pid'] in wanted:observed[(row['pid'],row['birth'])]=row
   save(directory/'observed-owned-processes.json',list(observed.values()))
   if time.monotonic()-start>900:raise TimeoutError('Owned E2E still running; preserved PID/identity receipts, no automatic forced kill or retry')
   time.sleep(1)
  code=child.wait()
 text=log.read_text(errors='replace');current=table();remnants=[row for row in current if (row['pid'],row['birth']) in observed]
 result={'name':name,'command':command,'cwd':str(ROOT),'startedAt':started,'elapsedSeconds':round(time.monotonic()-start,3),'exitCode':code,'passLines':len(re.findall(r'^PASS ',text,re.M)),'failLines':len(re.findall(r'^FAIL ',text,re.M)),'skipLines':len(re.findall(r'^SKIP ',text,re.M)),'allPassMarker':bool(re.search(r'E2E: ALL PASS',text)),'log':str(log),'logDigest':digest(log),'environment':values,'tmpdirPathBytes':len(os.fsencode(values['TMPDIR'])),'observedOwnedProcessIdentities':list(observed.values()),'remainingObservedOwnedProcessIdentities':remnants,'observationScope':'Popen-owned Node and descendants sampled once per second; transient children may not be observed. Script cleanup assertions cover its own exact identities. LaunchServices App process identities are checked separately from its native report.'}
 if name=='gui' and (directory/'results.json').exists():
  receipt=json.loads((directory/'results.json').read_text());events=receipt['reports'];result['receiverEvidenceDigest']=digest(directory/'results.json')
  result['inputSourceRestored']=any(e.get('event')=='input-source-restore' and e.get('restored') for e in events);result['clipboardRestored']=any(e.get('event')=='clipboard-restore' and e.get('restored') for e in events)
  result['recordedCalls']=len(receipt['results'])
 if name=='app' and (directory/'manual-host.json').exists():
  receipt=json.loads((directory/'manual-host.json').read_text());result['appEvidenceDigest']=digest(directory/'manual-host.json')
  checkScript="const fs=require('node:fs');const t=require('./dev-harness/lib/kill-own-tree').snapshotProcessTable();const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!t)process.exit(2);const a=t.filter(x=>r.observedProcesses.some(y=>y.pid===x.pid&&y.created===String(x.created)));process.stdout.write(JSON.stringify(a.map(x=>({pid:x.pid,created:String(x.created)}))));if(a.length)process.exit(1);"
  checkproc=subprocess.run([NODE,'-e',checkScript,str(directory/'manual-host.json')],cwd=ROOT,capture_output=True,text=True,env=env)
  result['launchServicesCleanupCheck']={'exitCode':checkproc.returncode,'stdout':checkproc.stdout,'stderr':checkproc.stderr,'observedProcesses':receipt.get('observedProcesses'),'remaining':json.loads(checkproc.stdout) if checkproc.stdout else None};assert checkproc.returncode==0,'App observed identity remains'
  result['candidateServiceInvocation']=receipt.get('serviceInvocation');result['candidateWorkbenchRoot']=receipt.get('workbenchRoot');result['receiver']=receipt.get('receiver');result['launch']=receipt.get('launch');result['permissionMode']='bypass fixture; normal approval allow/deny/cancel is outside scope'
 check(name+'-after');result['passed']=code==0 and result['passLines']>0 and result['failLines']==0 and result['skipLines']==0 and result['allPassMarker'] and not remnants
 save(directory/'report.json',result);RESULTS.append(result);save(OUT/'results.json',RESULTS)
 print(json.dumps({'stage':name,'exitCode':code,'pass':result['passLines'],'fail':result['failLines'],'skip':result['skipLines'],'passed':result['passed'],'seconds':result['elapsedSeconds']}),flush=True)
 assert result['passed'],'Independent '+name+' acceptance failed; no automatic rerun'
 if name=='gui':assert result.get('inputSourceRestored') and result.get('clipboardRestored'),'Source/clipboard restoration receipt missing'
 return result

try:
 check('initial');signatures={'before':[verify_signature(HELPER),verify_signature(APP,True)]};save(OUT/'artifact-signatures.json',signatures)
 run('gui','dev-harness/macos-manual-record.e2e.js');run('app','dev-harness/macos-input-host.e2e.js')
 signatures['after']=[verify_signature(HELPER),verify_signature(APP,True)];save(OUT/'artifact-signatures.json',signatures);check('final')
 save(OUT/'report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':now(),'status':'passed_independent_synthetic_gui_and_app_v6','freezePath':str(FREEZE),'freezeSha256':FREEZE_SHA,'frozenFiles':34,'allSourceArtifactChecksMatched':all(c['allMatched'] and c['freezeUnchanged'] and c['artifactsUnchanged'] for c in CHECKS),'checkpoints':len(CHECKS),'artifacts':ARTIFACTS,'productionHelperReusedFromV5':item,'engineeringReport':{'path':str(ENGINEERING),'digest':digest(ENGINEERING)},'runs':RESULTS,'independentScenarioInvocations':{'gui':1,'app':1},'independentAutomaticOrManualRetries':0,'history':'Root development GUI v7 timed out before nested-cancel held receipt; no root cause inferred. GUI diagnostic v8/root App v2 and this independent synthetic followup are explicit reruns in the overall project history. No overall zero-rerun claim.','phaseStatus':'in_progress','manualPhysicalFunctionalityAccepted':False,'limits':['Independent deterministic synthetic events exercise a real target-process event tap; no human hardware demonstration was performed by this reviewer','Physical v1/v2/v3 did not pass; Pressure-associated trackpad button recording remains an unresolved functionality gap','App uses the controlled bypass permission mode; normal approval/checkpoint and original P5 remaining audit/environment gates remain open'],'claim':'Independent synthetic GUI/App scope passes on the v6 fixture and byte-identical v5 runtime. This supports a partial implementation commit and does not approve the complete manual functionality or P5 phase.'})
 print('V6 SYNTHETIC GUI AND APP PASS',flush=True)
except BaseException as error:
 traceback.print_exc()
 try:check('failure-final')
 except BaseException:traceback.print_exc()
 save(OUT/'report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':now(),'status':'failed_or_blocked','error':repr(error),'results':RESULTS,'checks':CHECKS,'artifacts':ARTIFACTS,'phaseStatus':'in_progress','manualPhysicalFunctionalityAccepted':False,'retryPolicy':'No rerun after first failure; later stage not executed.'});raise
