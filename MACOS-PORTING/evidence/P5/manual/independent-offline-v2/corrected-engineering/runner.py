import datetime,hashlib,json,os,pathlib,re,subprocess,tempfile,time,traceback
ROOT=pathlib.Path('/tmp/ruyi-p5-manual-worktree')
OUT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/MACOS-PORTING/evidence/P5/manual/independent-offline-v2/corrected-engineering')
FREEZE=OUT.parent.parent/'development/sequence/current-source-v2.json'
DATA=json.loads(FREEZE.read_text()); FREEZE_SHA=hashlib.sha256(FREEZE.read_bytes()).hexdigest()
NODE='/Users/jiming/.local/bin/node'; CHECKS=[]; RESULTS=[]
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(path):
 b=pathlib.Path(path).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(name,value):(OUT/name).write_text(json.dumps(value,indent=2)+'\n')
def check(label):
 rows=[{'path':p,'expected':e,'actual':digest(ROOT/p)} for p,e in DATA['files'].items()]
 for row in rows:row['matched']=row['expected']==row['actual']
 x={'label':label,'at':now(),'files':rows,'count':len(rows),'allMatched':all(r['matched'] for r in rows),'freezeUnchanged':digest(FREEZE)['sha256']==FREEZE_SHA};CHECKS.append(x);save('source-checks.json',CHECKS)
 assert x['count']==34 and x['allMatched'] and x['freezeUnchanged'],'Frozen source drift'
def execute(name,command):
 check(name+'-before')
 base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='ruyi-v2-'))
 probe=subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 assert probe.returncode==128,'Isolation root must be outside git repository'
 values={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for path in values.values():pathlib.Path(path).mkdir()
 values.update({'RUYI_MACOS_AUTOMATION_HELPER':str(base/'absent-helper'),'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONPATH':str(ROOT/'mcp/ai-computer-control/src'),'PYTHONDONTWRITEBYTECODE':'1'})
 env=os.environ.copy();env.update(values)
 path=OUT/(name+'.txt');assert not path.exists(),'Refuse duplicate command'
 row={'name':name,'command':command,'cwd':str(ROOT),'startedAt':now(),'environment':values,'tmpdirPathBytes':len(os.fsencode(values['TMPDIR'])),'isolationRootGitProbe':{'command':['git','-C',str(base),'rev-parse','--show-toplevel'],'exitCode':probe.returncode,'stderr':probe.stderr.strip()},'log':str(path)}
 start=time.monotonic()
 with path.open('wb') as f:p=subprocess.run(command,cwd=str(ROOT),env=env,stdout=f,stderr=subprocess.STDOUT,timeout=900)
 row.update({'exitCode':p.returncode,'elapsedSeconds':round(time.monotonic()-start,3),'logDigest':digest(path)})
 text=path.read_text(errors='replace')
 row['summaryLines']=[line for line in text.splitlines() if re.search(r'^(?:ℹ|#) (?:tests|suites|pass|fail|cancelled|skipped|todo|汇总|件数)|\[flaky|\[retry\]|SKIP',line)]
 RESULTS.append(row);save('results.json',RESULTS);check(name+'-after')
 print(json.dumps({'name':name,'exitCode':p.returncode,'elapsedSeconds':row['elapsedSeconds'],'tmpdir':values['TMPDIR'],'tmpdirPathBytes':row['tmpdirPathBytes']}),flush=True)
 assert p.returncode==0,'Unexpected command failure '+name
 return text,row
try:
 check('initial')
 text,row=execute('fullunit',[NODE,'--test','dev-harness/unit/*.test.js'])
 row['counts']={k:int(re.search(r'^ℹ '+k+r' (\d+)$',text,re.M).group(1)) for k in ['tests','suites','pass','fail','cancelled','skipped','todo']}
 save('results.json',RESULTS)
 assert row['counts']['fail']==0 and row['counts']['cancelled']==0,'Nonpassing fullunit summary'
 text,row=execute('run-all-fast',[NODE,'dev-harness/run-all.js','--fast'])
 summary=re.search(r'^# 汇总: (\d+) pass / (\d+) fail / (\d+) known-fail / (\d+) unexpected-pass / (\d+) flaky / (\d+) ran / (\d+) skipped',text,re.M)
 if summary:row['counts']=dict(zip(['pass','fail','knownFail','unexpectedPass','flaky','ran','skipped'],map(int,summary.groups())))
 row['retryLines']=[line for line in text.splitlines() if '[retry]' in line or '[flaky:' in line]
 save('results.json',RESULTS)
 assert summary and row['counts']['fail']==0,'Missing/nonpassing fast summary'
 check('final')
 report={'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':now(),'status':'passed_corrected_offline_engineering','scope':'Only the controlled fullunit rerun and first fast invocation, after evidence-backed correction of acceptance TMPDIR. No native/Python/syntax/build repetition. No GUI or default helper/App/system-setting changes.','freezePath':str(FREEZE),'freezeSha256':FREEZE_SHA,'frozenFiles':34,'allSourceChecksMatched':all(c['allMatched'] and c['freezeUnchanged'] for c in CHECKS),'checkpoints':len(CHECKS),'priorInvalidReport':str(OUT.parent/'report.json'),'fullunitGateInvocations':{'priorInvalidEnvironment':1,'correctedValidEnvironment':1,'totalExplicitGateInvocations':2,'note':'Fast invokes its own documented unit preflight; any such nested execution is part of fast, not an extra manual fullunit gate retry.'},'fastGateInvocations':1,'additionalManualRetries':0,'results':RESULTS,'pending':['Expanded real GUI manual E2E','Ruyi App manual chain','Physical human input','Original P5 remaining audit and external gates'],'claim':'Offline engineering passes after correcting the acceptance environment. Does not establish complete manual/P5 acceptance; the prior invalid attempt remains preserved.'}
 save('report.json',report);print('CORRECTED OFFLINE ENGINEERING PASS',flush=True)
except BaseException as e:
 traceback.print_exc()
 try:check('failure-final')
 except BaseException:traceback.print_exc()
 save('report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':now(),'status':'failed_or_blocked','error':repr(e),'results':RESULTS,'checkpoints':CHECKS,'priorInvalidReport':str(OUT.parent/'report.json'),'scope':'Stopped at failure; no further command reruns authorized.'})
 raise
