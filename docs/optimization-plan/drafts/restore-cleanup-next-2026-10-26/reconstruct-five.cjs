'use strict';
// Source reconstruction only, starting from the exact archived PRIVATE union.
const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),a=require('node:assert/strict');
a.equal(process.argv.length,4,'usage: node reconstruct-five.cjs <archived-private-union-src> <new-output-directory>');
const src=p.resolve(process.argv[2]),out=p.resolve(process.argv[3]),key=value=>process.platform==='win32'?value.toLowerCase():value;
a.equal(fs.existsSync(out),false);const actual=p.join(fs.realpathSync(p.dirname(out)),p.basename(out)),base=fs.realpathSync(src);
a.ok(key(actual)!==key(base)&&!key(actual).startsWith(key(base)+p.sep));
const identity=JSON.parse(fs.readFileSync(p.join(__dirname,'frozen-five-source-identity.json'))),spans=JSON.parse(fs.readFileSync(p.join(__dirname,'all-cleanup-spans.json'))),hash=bytes=>c.createHash('sha256').update(bytes).digest('hex'),writes=[];
for(const before of identity.baseline){const name=before.file,original=fs.readFileSync(p.join(src,name),'utf8');a.equal(hash(original),before.sha256,name+' private baseline');let next=original;
 for(const span of spans[name]||[]){a.equal(next.split(span.before).length-1,1,name+' unique');next=next.replace(span.before,span.after);}
 const after=identity.products.find(row=>p.basename(row.file)===name);a.ok(after);a.equal(hash(next),after.sha256,name+' frozen result');let inverse=next;
 for(const span of [...(spans[name]||[])].reverse()){a.equal(inverse.split(span.after).length-1,1,name+' inverse');inverse=inverse.replace(span.after,span.before);}a.equal(inverse,original);writes.push([name,next]);
}
fs.mkdirSync(out);for(const [name,next] of writes)fs.writeFileSync(p.join(out,name),next);console.log(JSON.stringify({preparedOnly:true,files:writes.length,out}));
