import datetime,hashlib,json,os,pathlib,subprocess,tempfile,time,traceback
ROOT=pathlib.Path('/tmp/ruyi-p5-touch-worktree');OUT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/MACOS-PORTING/evidence/P5/manual/standard-mouse/independent-final-v2');BASE=OUT.parent;FREEZE=BASE/'freeze-v2.json';OLD=BASE/'freeze-v1.json';PRIOR=BASE/'independent-offline-v1/report.json';NODE='/Users/jiming/.local/bin/node'
def digest(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(n,o):(OUT/n).write_text(json.dumps(o,indent=2)+'\n')
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
new=json.loads(FREEZE.read_text());old=json.loads(OLD.read_text());prior=json.loads(PRIOR.read_text());assert prior['status']=='passed_standard_mouse_v1_offline_subset' and prior['pythonSmokeTests']==170 and prior['allSourceChecksMatched']
assert set(new['files'])==set(old['files']);changed=[n for n in new['files'] if new['files'][n]!=old['files'][n]];assert changed==['dev-harness/macos-manual-record.e2e.js']
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()==new['baseCommit']==old['baseCommit']
logs=[]
for step in prior['steps']:
 assert digest(step['log'])==step['logDigest'];logs.append({'name':step['name'],'path':step['log'],'digest':step['logDigest']})
helper=next(x for x in prior['artifacts'] if x['mode']=='production');assert digest(helper['path'])=={k:helper[k] for k in ['bytes','sha256']}
physical=BASE/'physical-evidence-review-v1.json';physical_review=json.loads(physical.read_text());assert physical_review['verdict']=='passed_independent_physical_record_provenance_review'
for a in physical_review['artifacts']:
 p=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac')/a['path'];assert digest(p)=={k:a[k] for k in ['bytes','sha256']}
BINDING={'at':stamp(),'v1Manifest':{'path':str(OLD),'digest':digest(OLD)},'v2Manifest':{'path':str(FREEZE),'digest':digest(FREEZE)},'priorOfflineReport':{'path':str(PRIOR),'digest':digest(PRIOR)},'changedPaths':[{'path':n,'v1':old['files'][n],'v2':new['files'][n]} for n in changed],'unchangedSourceCount':33,'unchangedSources':[{'path':n,**new['files'][n]} for n in new['files'] if n not in changed],'reusedHelper':helper,'reusedScope':{'exactNativeCases':50,'standardProjectionCases':20,'nativePythonFieldCases':56,'schemaCases':11,'wholeNativePreflightRefusals':3,'pythonSmokeTests':170,'pythonSkipped':0,'fullunit':prior['engineeringSummary']['fullunit'],'fast':prior['engineeringSummary']['fast'],'automaticRetries':0},'priorLogsVerified':logs,'separatePhysicalSourceReview':{'path':str(physical),'digest':digest(physical),'scope':physical_review['scope'],'interpretation':'This is a separate reviewer source/record audit of the parent-executed physical demonstration, not new physical execution by p5_acceptance.'}}
save('source-delta-binding.json',BINDING);FROZEN=digest(FREEZE)['sha256'];PRIOR_SHA=digest(PRIOR)['sha256'];CHECKS=[];RESULTS=[]
def check(label):
 rows=[{'path':n,'expected':e,'actual':digest(ROOT/n)} for n,e in new['files'].items()]
 for r in rows:r['matched']=r['actual']==r['expected']
 c={'label':label,'at':stamp(),'files':rows,'count':len(rows),'allMatched':all(r['matched'] for r in rows),'freezeUnchanged':digest(FREEZE)['sha256']==FROZEN,'reusedReportUnchanged':digest(PRIOR)['sha256']==PRIOR_SHA};CHECKS.append(c);save('delta-source-checks.json',CHECKS);assert c['count']==34 and c['allMatched'] and c['freezeUnchanged'] and c['reusedReportUnchanged']
try:
 check('initial')
 for name,command in [('syntax',[NODE,'dev-harness/syntax-gate.js']),('build-check',[NODE,'ruyi-workbench/app/build.js','--check'])]:
  check(name+'-before');base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='ruyi-sm2-d-'));probe=subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True);assert probe.returncode==128
  vals={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
  for v in vals.values():pathlib.Path(v).mkdir()
  vals['RUYI_MACOS_AUTOMATION_HELPER']=str(base/'absent-helper');env=os.environ.copy();env.update(vals);log=OUT/(name+'.txt');assert not log.exists(),'Refuse repeated gate';start=time.monotonic()
  with log.open('wb') as f:p=subprocess.run(command,cwd=ROOT,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=180)
  row={'name':name,'command':command,'exitCode':p.returncode,'elapsedSeconds':round(time.monotonic()-start,3),'environment':vals,'tmpdirPathBytes':len(os.fsencode(vals['TMPDIR'])),'log':str(log),'logDigest':digest(log)};RESULTS.append(row);save('delta-results.json',RESULTS);check(name+'-after');print(json.dumps({'gate':name,'exitCode':p.returncode,'seconds':row['elapsedSeconds']}),flush=True);assert p.returncode==0
 check('final')
 save('delta-engineering.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':stamp(),'status':'passed_standard_mouse_v2_delta_checks','freezePath':str(FREEZE),'freezeSha256':FROZEN,'sourceFiles':34,'checkpoints':len(CHECKS),'allMatched':True,'sourceDeltaBinding':{'path':str(OUT/'source-delta-binding.json'),'digest':digest(OUT/'source-delta-binding.json')},'reuse':BINDING,'newRuns':RESULTS,'nativePythonFullunitFastReexecuted':False,'newCommandRetries':0,'phaseStatus':'in_progress','scope':'One JS manual harness change; native/Python/runtime/physical fixture byte-identical to v1. Fresh syntax/build checks; prior native/Python/unit/fast explicitly reused. GUI/App runs follow separately. No pressure-gesture acceptance or P5-completion claim.'})
 print('STANDARD V2 DELTA PASS',flush=True)
except BaseException as e:
 traceback.print_exc()
 try:check('failure-final')
 except BaseException:traceback.print_exc()
 save('delta-engineering.json',{'schemaVersion':1,'status':'failed_or_blocked','error':repr(e),'results':RESULTS,'checks':CHECKS,'binding':BINDING});raise
