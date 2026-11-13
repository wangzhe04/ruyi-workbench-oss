import datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time
ROOT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac')
CASE=sys.argv[1]; assert CASE in ('default','renderer','finder')
OUT=pathlib.Path(sys.argv[2]).resolve(); OUT.mkdir(parents=True,exist_ok=False)
BASE=pathlib.Path(tempfile.mkdtemp(prefix='p5sa-',dir='/tmp'))
NODE='/Users/jiming/.local/share/nodejs/node-v24.15.0-darwin-arm64/bin/node'
PROCESS=ROOT/'ruyi-workbench/runtime/macos/ruyi-process-helper'
DEFAULT=ROOT/'ruyi-workbench/runtime/macos/ruyi-automation-helper'
EXPECTED_DEFAULT='1cc945ded67ff7b8bc487abeb7b7017aa07ca3256b8229f875e71bc249185dc5'
CFT='/Users/jiming/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
ART=BASE/'artifacts'; ART.mkdir(); OBS={}; HELPERS={}; ERRORS=[]; ROOT_BIRTH=None
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(name,value): (OUT/name).write_text(json.dumps(value,indent=2)+'\n')
def table():
 p=subprocess.run([str(PROCESS),'--snapshot'],capture_output=True,text=True,timeout=8,check=True)
 assert p.stdout.startswith('RUYI-PROCESS-V1\n')
 rows=[]
 for line in p.stdout.splitlines()[1:]:
  fields=line.split(',');
  if len(fields)>=3:rows.append({'pid':int(fields[0]),'ppid':int(fields[1]),'created':int(fields[2])})
 return rows
def sample(child):
 global ROOT_BIRTH
 before=table(); bypid={r['pid']:r for r in before}; root=bypid.get(child.pid)
 if root and ROOT_BIRTH is None and root['ppid']==os.getpid() and child.poll() is None:ROOT_BIRTH=root['created']
 owned=set()
 if root and root['created']==ROOT_BIRTH:
  owned={child.pid}; changed=True
  while changed:
   changed=False
   for r in before:
    parent=bypid.get(r['ppid'])
    if r['pid'] not in owned and r['ppid'] in owned and parent and r['created']>=parent['created']:
     owned.add(r['pid']);changed=True
 ps=subprocess.run(['/bin/ps','-ww','-axo','pid=,command='],capture_output=True,text=True,timeout=5,check=True)
 after={r['pid']:r for r in table()}
 for pid in owned:
  row=bypid[pid]
  if after.get(pid,{}).get('created')==row['created']:OBS[(pid,row['created'])]=row
 fixture_roots={str(p) for p in (BASE/'t').glob('ruyi-p5-apps-*') if p.is_dir()}
 for line in ps.stdout.splitlines():
  f=line.strip().split(None,1)
  if len(f)!=2:continue
  pid=int(f[0]); command=f[1]; tag=re.search(r'(?:^|\s)-RuyiP5Fixture\s+(\S+)(?=\s|$)',command)
  row=bypid.get(pid)
  if command.startswith('/System/Applications/TextEdit.app/Contents/MacOS/TextEdit ') and tag and tag.group(1) in fixture_roots and row and after.get(pid,{}).get('created')==row['created']:
   OBS[(pid,row['created'])]={**row,'command':command,'ownership':'complete exact fixture tag; birth unchanged across command observation'}
 for p in (BASE/'t').glob('ruyi-p5-*/helper'):
  if not p.is_file():continue
  try:
   h=digest(p)
   if h['sha256'] in HELPERS:continue
   signed=subprocess.run(['/usr/bin/codesign','--verify','--strict',str(p)],capture_output=True,text=True,timeout=5)
   if signed.returncode:continue
   dest=ART/h['sha256'];shutil.copyfile(p,dest);assert digest(dest)==h
   HELPERS[h['sha256']]={'originalPath':str(p),'preservedOutsideGit':str(dest),**h,'codesignExit':signed.returncode}
  except FileNotFoundError:pass

env=os.environ.copy()
for key in ['WCW_SESSION_ID','RUYI_P5_APPS_BLOCK_CDP','RUYI_P5_TEXTEDIT_FAIL_BEFORE_OBSERVE','RUYI_P5_FINDER_FAIL_AFTER_OBSERVE','RUYI_INDEPENDENT_BROWSER_MODE','RUYI_P5_APPS_AX_RENDERER']:env.pop(key,None)
vals={k:str(BASE/v) for k,v in [('HOME','h'),('USERPROFILE','h'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','r'),('TMPDIR','t')]}
for v in set(vals.values()):pathlib.Path(v).mkdir()
vals.update({'RUYI_REAL_HOME':'/Users/jiming','RUYI_ACC_PYTHON':str(ROOT/'mcp/ai-computer-control/.venv/bin/python'),'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONDONTWRITEBYTECODE':'1','RUYI_P5_INPUT_REQUIRED':'1','RUYI_P5_EVIDENCE':str(OUT),'RUYI_E2E_BROWSER':CFT})
if CASE=='finder':vals['RUYI_P5_FINDER_REQUIRED']='1'; script='dev-harness/macos-ax-finder.e2e.js'
else:vals.update({'RUYI_P5_APPS_AX':'1','RUYI_P5_APPS_AX_RENDERER':'1' if CASE=='renderer' else '0'});script='dev-harness/macos-input-apps.e2e.js'
env.update(vals)
assert len(os.fsencode(vals['TMPDIR']))<32
paths=subprocess.check_output(['git','ls-files','ruyi-workbench/resources/macos-*','mcp/ai-computer-control/src','MACOS-PORTING/evidence/P5/manual/compare-helper-builds.js','ruyi-workbench/tools/build-macos-automation-helper.js','ruyi-workbench/app/server.js','ruyi-workbench/app/src/12-tool-dispatch.js','dev-harness/macos-input-apps.e2e.js','dev-harness/macos-ax-finder.e2e.js','dev-harness/fixtures','dev-harness/lib/kill-own-tree.js','dev-harness/lib/browser-fixture.js','dev-harness/lib/fixture-home.js','dev-harness/lib/self-isolate-home.js','dev-harness/lib/server-internals.js'],cwd=ROOT,text=True).splitlines()
FROZEN=[];ARTIFACTS_BEFORE={};child=None;code=None;comparisons=[];blocked=False;started=now();start=time.monotonic()
try:
 FROZEN=[{'path':p,**digest(ROOT/p)} for p in paths]; save('source-before.json',FROZEN)
 assert any(x['path']=='ruyi-workbench/resources/macos-automation-input.m' for x in FROZEN)
 ARTIFACTS_BEFORE={'defaultHelper':digest(DEFAULT),'processHelper':digest(PROCESS),'browserLauncher':digest(CFT),'observerScript':digest(__file__)}
 assert ARTIFACTS_BEFORE['defaultHelper']['sha256']==EXPECTED_DEFAULT
 save('artifacts-before.json',ARTIFACTS_BEFORE)
 command=[NODE,script]
 save('invocation.json',{'case':CASE,'command':command,'environment':vals,'base':str(BASE),'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'startedAt':started,'scope':'Primary execution of unchanged selected-app scenes. Sampler only observes identities and copies signed helper bytes; it never injects input or closes applications.'})
 with (OUT/'output.txt').open('wb') as log:
  child=subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
  while child.poll() is None:
   try:sample(child)
   except Exception as error:ERRORS.append({'stage':'sample','error':repr(error)})
   save('observed-identities.json',list(OBS.values()));save('helpers.json',list(HELPERS.values()))
   if time.monotonic()-start>900:
    blocked=True;ERRORS.append({'stage':'budget','error':'Fixture still running; later cases must stop. No unverified forced intervention.'});break
   time.sleep(.2)
  code=child.poll()
 for h in HELPERS.values():
  row={'helper':h['preservedOutsideGit']}
  try:
   q=subprocess.run([NODE,str(ROOT/'MACOS-PORTING/evidence/P5/manual/compare-helper-builds.js'),str(DEFAULT),h['preservedOutsideGit']],capture_output=True,text=True,timeout=20)
   row.update({'exitCode':q.returncode,'stdout':q.stdout,'stderr':q.stderr})
   row['result']=json.loads(q.stdout)
  except Exception as error:
   row['error']=repr(error)
   for key in ['stdout','stderr']:
    value=getattr(error,key,None)
    if value is not None:row[key]=value.decode(errors='replace') if isinstance(value,bytes) else value
   ERRORS.append({'stage':'helper comparison','error':repr(error)})
  comparisons.append(row)
except BaseException as error:
 ERRORS.append({'stage':'execution','error':repr(error)})
 if child and child.poll() is None:blocked=True
finally:
 current=None;after=None;ARTIFACTS_AFTER=None
 try:current=table()
 except Exception as error:ERRORS.append({'stage':'final process snapshot','error':repr(error)})
 try:
  after=[{'path':p,**digest(ROOT/p)} for p in paths];save('source-after.json',after)
 except Exception as error:ERRORS.append({'stage':'final source snapshot','error':repr(error)})
 try:
  ARTIFACTS_AFTER={'defaultHelper':digest(DEFAULT),'processHelper':digest(PROCESS),'browserLauncher':digest(CFT),'observerScript':digest(__file__)}
  save('artifacts-after.json',ARTIFACTS_AFTER)
 except Exception as error:ERRORS.append({'stage':'final artifact snapshot','error':repr(error)})
 remaining=None if current is None else [r for r in current if (r['pid'],r['created']) in OBS]
 text=(OUT/'output.txt').read_text(errors='replace') if (OUT/'output.txt').exists() else ''
 result={'case':CASE,'executor':'/root','status':'blocked' if blocked else 'failed','startedAt':started,'seconds':time.monotonic()-start,'exitCode':code,'childPid':child.pid if child else None,'childStillRunning':child.poll() is None if child else False,'observedRootBirth':ROOT_BIRTH,'pass':len(re.findall(r'^PASS ',text,re.M)),'fail':len(re.findall(r'^FAIL ',text,re.M)),'skip':len(re.findall(r'^SKIP ',text,re.M)),'sourceCount':len(FROZEN),'sourceUnchanged':bool(FROZEN) and FROZEN==after,'artifactsUnchanged':bool(ARTIFACTS_BEFORE) and ARTIFACTS_BEFORE==ARTIFACTS_AFTER,'observedIdentityCount':len(OBS),'remainingObservedIdentities':remaining,'samplerErrors':ERRORS,'helpers':list(HELPERS.values()),'helperComparisons':comparisons,'temporaryEvidenceRoot':str(BASE),'scope':'Only sampled birth-verified descendants and exact LaunchServices TextEdit fixture tag are counted; transient unobserved processes are outside this sampler. The unchanged fixtures independently assert their own cleanup and clipboard restoration. Shared Finder is never killed by the sampler.','phaseStatus':'in_progress'}
 result['passed']=not blocked and code==0 and result['pass']>0 and result['fail']==0 and result['skip']==0 and 'E2E: ALL PASS' in text and result['sourceUnchanged'] and result['artifactsUnchanged'] and ROOT_BIRTH is not None and remaining==[] and not ERRORS and bool(HELPERS) and len(comparisons)==len(HELPERS) and all(q.get('exitCode')==0 and q.get('result',{}).get('equivalent') is True for q in comparisons)
 if result['passed']:result['status']='passed_primary_selected_case'
 save('report.json',result);print(json.dumps({k:result[k] for k in ['case','status','passed','pass','fail','skip','seconds']}),flush=True)
# Preserve signed binaries only outside Git and retain the case root for independent provenance review.
if not result['passed']:sys.exit(1)
