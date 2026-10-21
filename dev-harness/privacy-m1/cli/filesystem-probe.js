'use strict';
// Synthetic-only adversarial probe. Never emit file bytes, directory entries or absolute paths.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
function run(config,descendant=false) {
  const emit=value=>process.stdout.write(JSON.stringify({kind:'filesystem',descendant,...value})+'\n');
  const check=(name,operation,work)=>{try {emit({name,operation,allowed:true,verified:work()===true});}catch(error){emit({name,operation,allowed:false,code:error.code||error.name,syscall:error.syscall});}};
  emit({name:'probe',operation:'ready',allowed:true,verified:true});
  for(const fixture of config.fixtures) {
    check(fixture.name,'read',()=>fs.readFileSync(path.join(fixture.directory,'marker.txt'),'utf8')===fixture.expected);
    check(fixture.name,'enumerate',()=>fs.readdirSync(fixture.directory).includes('marker.txt'));
    check(fixture.name,'write',()=>{fs.writeFileSync(path.join(fixture.directory,(descendant?'child':'parent')+'-write.txt'),'SYNTHETIC_OUTPUT');return true;});
    check(fixture.name,'extended-read',()=>fs.readFileSync('\\\\?\\'+path.join(fixture.directory,'marker.txt'),'utf8')===fixture.expected);
  }
  const storage=process.env.RUYI_M1_PROFILE_STORAGE;
  if(storage) {
    check('profile-storage','read',()=>fs.readFileSync(path.join(storage,'marker.txt'),'utf8')==='SYNTHETIC_PROFILE_STORAGE');
    check('profile-storage','enumerate',()=>fs.readdirSync(storage).includes('marker.txt'));
    check('profile-storage','write',()=>{fs.writeFileSync(path.join(storage,(descendant?'child':'parent')+'-write.txt'),'SYNTHETIC_OUTPUT');return true;});
  }
  for(const link of config.junctions) {
    const alias=path.join(config.write,(descendant?'child-':'parent-')+link.name);
    check(link.name,'junction-create',()=>{fs.symlinkSync(link.directory,alias,'junction');return fs.lstatSync(alias).isSymbolicLink();});
    check(link.name,'junction-read',()=>fs.readFileSync(path.join(alias,'marker.txt'),'utf8')===link.expected);
    check(link.name,'junction-enumerate',()=>fs.readdirSync(alias).includes('marker.txt'));
    check(link.name,'junction-write',()=>{fs.writeFileSync(path.join(alias,(descendant?'child':'parent')+'-junction-write.txt'),'SYNTHETIC_OUTPUT');return true;});
  }
  for(const [name,file] of Object.entries(config.hardlink))check('hardlink-'+name,'read',()=>fs.readFileSync(file,'utf8')==='SYNTHETIC_HARDLINK_SECRET');
  check('project','read',()=>fs.readFileSync(config.project,'utf8')==='SYNTHETIC_MODEL_VIEW');
  check('project','write',()=>{fs.writeFileSync(config.project,'MUTATED');return true;});
  check('output','write',()=>{fs.writeFileSync(path.join(config.write,(descendant?'child':'parent')+'-owned.txt'),'SYNTHETIC_OUTPUT');return true;});
  const token=cp.spawnSync(config.tokenProbe,['--token-self'],{env:process.env,windowsHide:true,stdio:['ignore','inherit','inherit'],timeout:5000});
  emit({name:'actual-descendant-token',operation:'token',exitCode:token.status,errorCode:token.error?.code});
  if(!descendant) {
    const child=cp.spawnSync(process.execPath,['--preserve-symlinks-main',__filename,process.argv[2],'child'],{env:process.env,stdio:['ignore','inherit','inherit'],windowsHide:true,timeout:15000});
    emit({name:'child',operation:'exit',exitCode:child.status,errorCode:child.error?.code});
    if(child.status!==0)process.exitCode=1;
  }
}
if(require.main===module)run(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),process.argv[3]==='child');
module.exports={run};
