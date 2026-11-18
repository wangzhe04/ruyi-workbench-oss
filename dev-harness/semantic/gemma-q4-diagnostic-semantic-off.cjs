'use strict';
// Before boot only, configure an already-owned synthetic fixture to forbid
// model startup. Never touches an existing root outside that fixture.
const fs=require('node:fs'),path=require('node:path');
function apply(fixture,root){root=fs.realpathSync(root);const base=fs.realpathSync(fixture.base),relative=path.relative(root,base);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('diagnostic.fixture_outside_root');const file=path.join(base,'config.json'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(file)!==file)throw Error('diagnostic.config_alias');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));cfg.semanticRetrievalV1=false;fs.writeFileSync(file,JSON.stringify(cfg,null,2)+'\n');fixture.env.RUYI_DISABLE_SEMANTIC='1';return Object.freeze({configSemanticEnabled:false,disableSemanticEnv:true});}
module.exports={apply};
