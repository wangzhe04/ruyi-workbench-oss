import asyncio, importlib.util,json,os,ntpath,posixpath,tempfile,traceback,subprocess,types
from pathlib import Path
from unittest.mock import patch
ROOT=Path('/Users/jiming/Documents/ruyi-workbench-mac')
spec=importlib.util.spec_from_file_location('smoke_browser_runtime_review',ROOT/'mcp/ai-computer-control/tests/smoke_browser_runtime.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
old_source=subprocess.check_output(['git','show','HEAD:mcp/ai-computer-control/tests/smoke_browser_runtime.py'],cwd=ROOT,text=True)
old_module=types.ModuleType('smoke_browser_runtime_old_review');old_module.__file__=str(ROOT/'mcp/ai-computer-control/tests/smoke_browser_runtime.py');exec(compile(old_source,old_module.__file__,'exec'),old_module.__dict__)
async def check(name,path_module=None,pin_posix_join=False,selected=module):
 case=selected.BrowserRuntime('test_installed_mac_browser_detection_retains_windows_resolver')
 await case.asyncSetUp()
 try:
  from contextlib import ExitStack
  with ExitStack() as stack:
   if path_module:stack.enter_context(patch.object(case.browser.os,'path',path_module))
   if pin_posix_join:stack.enter_context(patch.object(case.browser.os.path,'join',posixpath.join))
   try:
    await case.test_installed_mac_browser_detection_retains_windows_resolver();return {'name':name,'passed':True}
   except Exception as exc:return {'name':name,'passed':False,'type':type(exc).__name__,'error':str(exc)}
 finally:await case.asyncTearDown()
async def main():
 results=[await check('original test/native POSIX path host',selected=old_module),await check('original test/simulated Windows ntpath host',ntpath,selected=old_module),await check('fixed test/native POSIX path host'),await check('fixed test/simulated Windows ntpath host',ntpath)]
 print(json.dumps(results,ensure_ascii=False,indent=2))
 Path('/tmp/ruyi-p3-windows-browser-fixture-review.json').write_text(json.dumps({'scope':'Actual single smoke test under native and ntpath path modules. Windows path semantics simulation only; not a real Windows run.','results':results},ensure_ascii=False,indent=2)+'\n')
with tempfile.TemporaryDirectory(prefix='ruyi-browser-fixture-review-home-') as d:
 with patch.dict(os.environ,{'HOME':d,'USERPROFILE':d,'WCW_DATA_DIR':d+'/data','ACC_TOOLSETS':'browser,filesystem'}):asyncio.run(main())
