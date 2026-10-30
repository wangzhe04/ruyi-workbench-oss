'use strict';
// Data-only derivation from exact sealed metadata. Reads JSON/source text only;
// never copies payloads, imports Python, installs, downloads, or grants launch.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const PROFILE_ID = 'm4-image-cpython312-candidate-v2';
const PINS = Object.freeze({
  candidate:'1e01e0b5e0ad9c5e4f83e000c9cbbc9328cc7b508930de208c9ce3dbac653f50',
  mapping:'1179459f5ad6fb8046c59c8dd645b3e1d10c4ffccde397ee5b9f61ac6bda1564',
  legacyRuntime:'4e84862cf50907c84b14a55dcabcc347ae3a52e78a88031b7ecb878565d6735f',
  legacySources:'96b07893303e89c9ba668247aa9fb95a15d879c7fd741e674dbfc8491d11fd29'
});
function readPinned(file, expected) { const bytes = fs.readFileSync(file); if (sha(bytes) !== expected) throw Error('profile.generator_input_changed'); return JSON.parse(bytes); }
function derive({ candidateBytes, mappingBytes, legacyBytes, workerSource }) {
  for (const [bytes, expected] of [[candidateBytes,PINS.candidate],[mappingBytes,PINS.mapping],[legacyBytes,PINS.legacyRuntime]]) {
    if (!Buffer.isBuffer(bytes) || sha(bytes) !== expected) throw Error('profile.generator_input_changed');
  }
  const candidate = JSON.parse(candidateBytes), mapping = JSON.parse(mappingBytes), legacy = JSON.parse(legacyBytes);
  if (candidate.files !== 3251 || candidate.bytes !== 396911379 || candidate.ready !== false || candidate.execute !== false || candidate.sourceArchiveAvailable !== false || candidate.provenanceComplete !== false || candidate.legalAcceptance !== false) throw Error('profile.generator_state');
  const match = /  const SCRIPT = ("[^\n]*");/.exec(workerSource), worker = match && JSON.parse(match[1]);
  const versionMatch = /  const VERSION = '([a-z0-9-]{1,96})';/.exec(workerSource), workerVersion=versionMatch?.[1];
  if (typeof worker !== 'string' || !workerVersion || !worker.includes('\nVERSION = '+JSON.stringify(workerVersion)+'\n')) throw Error('profile.generator_worker');
  const observations = new Map(mapping.candidate.map(row => [row.path,row]));
  const artifacts = candidate.rows.map(row => {
    const observation = observations.get(row.path);
    if (!observation || observation.status !== 'match' || row.bytes !== observation.bytes || row.sha256 !== observation.sha256 || row.source !== observation.source || row.bytes !== observation.observed.bytes || row.sha256 !== observation.observed.sha256) throw Error('profile.generator_mapping');
    return { path:row.path, bytes:row.bytes, sha256:row.sha256 };
  });
  if (artifacts.length !== 3251 || artifacts.reduce((n,row) => n+row.bytes,0) !== 396911379 || new Set(artifacts.map(row => row.path.toLowerCase())).size !== 3251) throw Error('profile.generator_inventory');
  const legacyByPath = new Map(legacy.artifacts.map(row => [row.path,row]));
  const rowsByPath = new Map(artifacts.map(row => [row.path,row]));
  const omitted = legacy.artifacts.filter(row => !rowsByPath.has('payload/'+row.path));
  const omissions = { bytecode:omitted.filter(row => row.path.endsWith('.pyc')).length, record:omitted.filter(row => row.path.endsWith('/RECORD')).length, scripts:omitted.filter(row => row.path.includes('/Scripts/') && !row.path.endsWith('.pyc')).length };
  if (JSON.stringify(omissions) !== JSON.stringify({bytecode:1732,record:7,scripts:9}) || omitted.length !== 1748) throw Error('profile.generator_delta');
  let sameTuples = 0;
  for (const row of artifacts.filter(row => row.path.startsWith('payload/'))) {
    const old = legacyByPath.get(row.path.slice(8));
    if (old && row.bytes === old.bytes && row.sha256 === old.sha256) sameTuples++;
  }
  if (sameTuples !== 3238) throw Error('profile.generator_delta');
  const flags = { sourceArchiveAvailable:false, provenanceComplete:false, legalAcceptance:false, executionAuthorized:false, ready:false };
  const sources = {
    schema:1, kind:'media-corresponding-source-recipe', profileId:PROFILE_ID,
    scope:'Source correspondence work queue; technical source sets, archive byte identity, build provenance and distribution permission are separate claims.',
    legacy:{ artifact:'opencv-windows-ffmpeg-source-sidecar.zip', bytes:19922194, sha256:'09b13acc951b1ca1ed5f0971a51564599daad1bf733d2bf1f02c29d5c124f0d7', contentLockSha256:'9129d3e4e08b5cf59311e97bf71f64ed1ba521533c35aa859362ddfca8d4db40', provenanceSha256:'19f223b29e6ff7b1eef46a08685e157e7e5f2c81ce76c6ad48a968bb8f8aa249', restored:false, contentLockLocated:false, exactArchiveReconstructionProved:false },
    evidence:[
      { kind:'retained-primary-observations-and-recovery-route', file:'docs/optimization-plan/evidence/m3-host-m4-stage-20261027/blobs/4968ffd371ca54231d74da585709b33dbc700e8daff4203ad13a89327258efd3.gz', decodedSha256:'4968ffd371ca54231d74da585709b33dbc700e8daff4203ad13a89327258efd3', authority:'historical observations only; no new network query' },
      { kind:'opencv-and-font-technical-set', file:'docs/optimization-plan/evidence/m4-source-technical-closure-20261029.json', bytes:380152, sha256:'fa14e742fbda8d09b5de541d0468480572e4cc0a85bb4f4625a25fd66422935a', paths:6909, uniqueObjects:6728, coversFullRuntimeCorrespondingSource:false, coversLegacy09b:false }
    ],
    binaryInputs:artifacts.filter(row => row.path.endsWith('.whl') || row.path === 'payload/python_embed/python312.zip' || row.path === 'payload/python_embed/python312.dll' || row.path === 'payload/python_embed/python.exe' || row.path.endsWith('/cv2.pyd') || row.path.endsWith('/opencv_videoio_ffmpeg500_64.dll')),
    components:legacy.components.map(row => ({ name:row.name, version:row.version, metadata:row.metadata, metadataSha256:row.metadataSha256, licenseFiles:row.licenseFiles, sourceCorrespondence:'pending', buildProvenance:'pending', distributionAcceptance:'pending' })),
    tasks:[
      { id:'cpython', requirement:'Exact CPython 3.12.10 embedded distribution origin, release signatures/recipe and interpreter/stdlib/native source and notices; current tool Python 3.12.14 is unrelated.', status:'pending' },
      { id:'wheel-release', requirement:'Bind each listed wheel to its immutable release/source/recipe and installed member correspondence; preserve exact METADATA and notices; wheel bytes alone do not prove source/build/legal closure.', status:'pending' },
      { id:'opencv-release', requirement:'Separate opencv-python b83046cda41133f1bf2e73e99dba16a1248f103a and OpenCV submodule 40738fb16ceddb5fb3fea747585f7ce6abb0605b from the FFmpeg plugin wrapper source a0a660fcb1e58a295e6caa6aee64ed4d369b0181.', status:'pending' },
      { id:'ffmpeg', requirement:'Bind plugin binary 06dc20cad65dc7fcf784f70c95d46750520889a7 to source commit 664c0098dcb47b361f20c1d6a518653c23f5f2b5; independently close FFmpeg n7.1, libvpx v1.16.0, AOM v3.14.1, OpenH264 API v2.5.0, wrapper, build flags, static compiler runtime, LICENSE/NOTICE/PATENTS and source/member census.', status:'pending' },
      { id:'openh264', requirement:'The historical 32-byte API archive is insufficient evidence of headers. Corresponding wels headers/LICENSE, any external codec and actual enabled paths require independent closure.', status:'pending' },
      { id:'old-content-lock', requirement:'Original 9129 content-lock and 19f provenance bytes remain unlocated in the bounded retained route. Hashes cannot reconstruct them or the exact ZIP encoding of 09b; use a new identity for new material.', status:'pending' },
      { id:'distribution', requirement:'Independent complete notices/source/package-distribution review. No legal acceptance is inferred from a technical source collection or license filenames.', status:'pending' }
    ], ...flags
  };
  const sourceBytes = Buffer.from(JSON.stringify(sources,null,2)+'\n');
  const profile = {
    schema:1, kind:'media-resource-qualification-profile', id:PROFILE_ID, status:'qualification-pending',
    pythonVersion:'3.12.10', platform:'win32-x64', files:3251, bytes:396911379,
    candidateMetadataSha256:PINS.candidate, mappingSha256:PINS.mapping,
    sourceRecipe:{ file:PROFILE_ID+'-sources.json', bytes:sourceBytes.length, sha256:sha(sourceBytes) },
    legacy:{ profileId:'legacy-full-4987-v1', runtimeLockSha256:PINS.legacyRuntime, sourcesLockSha256:PINS.legacySources, runtimeFiles:4987, runtimeBytes:413946142, unchanged:true },
    delta:{ sameLegacyTuples:3238, additionalHistoricalControls:12, omittedLegacyFiles:1748, omissions,
      bootstrap:{ path:'payload/python_embed/python312._pth', beforeBytes:74, beforeSha256:'4e5d13eebfcbf19c28878dda362f0cd856c3f44c3b741510e4145f72103a9eef', afterBytes:37, afterSha256:'f61e7cd22a7fb30bd1f6c38bf492ad1bcbb5317fa6b54fb72e4345f9dd41ff84', afterBase64:'cHl0aG9uMzEyLnppcA0KLg0KTGliL3NpdGUtcGFja2FnZXMNCg==' } },
    worker:{ kind:'application-inline-source', sha256:sha(worker), version:workerVersion, historicalControlWorkerActive:false },
    graph:{ directImports:['asyncio','hashlib','io','json','math','struct','sys','PIL.Image','PIL.ImageOps','winsdk.windows.media.ocr','winsdk.windows.globalization','winsdk.windows.graphics.imaging','winsdk.windows.storage.streams','cv2','numpy'], transitiveImportClosure:'pending', nativeDllClosure:'pending', targetOsLanguageAndResourceClosure:'pending', codecBranches:'PNG/JPEG/WEBP/BMP single frame plus real OCR/QR/supported-linear; qualification pending', otherRetainedPackages:'conservative complete candidate inventory; PDF/Office/video capabilities remain in delivery scope and pending' },
    proposedLaunch:{ executable:'payload/python_embed/python.exe', argv:['-I','-S','-B','-X','utf8','-c','<application-inline-worker>'], cwd:'payload/python_embed', sysPath:['payload/python_embed/python312.zip','payload/python_embed','payload/python_embed/Lib/site-packages'], automaticSiteImport:false, dynamicPthAllowed:false, looseBytecodeAllowed:false, stdlibZipEntries:'control/resources/stdlib-zip-entries.json', environmentPolicy:'pending trusted OS roots, fresh owned TEMP/TMP, fixed DLL search, target language/resources; no PATH/PYTHON*/cwd/user site inheritance', namespaceLease:'pending OS enforced lease across final await/spawn/close; byte observations do not provide it' },
    qualificationGaps:['owned-restore-readback','private-namespace-lease','startup-import-and-transient-resource-closure','native-dll-search-and-trusted-os-boundary','target-ocr-language','complete-corresponding-source-and-notices','independent-execution-owner-review','actual-image-ocr-qr-and-process-close'],
    artifacts, ...flags
  };
  const restoreMap = { schema:1, kind:'media-resource-restore-map', profileId:PROFILE_ID,
    candidateMetadataSha256:PINS.candidate, sourceAuthority:'Explicit root-assigned restore operator must adopt fixed sources with stable read handles; manifest/audit observations grant no permission or exclusion lease.',
    targetPolicy:'New empty target owned by the restore operation; no existing-tree merge, alias, hardlink, fallback, overwrite, execute or installation.',
    steps:['assert fixed metadata pins and source-owner scope','open and hold each exact source with ancestor/no-alias/nlink checks','copy held fd to wx target member while hashing within exact byte budget','fsync file; read back through target fd and compare bytes/SHA; compare source fd and visible identity','close target/source; fsync owned directories where supported, otherwise report durability pending','verify complete target profile tree and report observation only','retain failed owned tree and report failure; no retry/cleanup outside owned paths'],
    rows:candidate.rows.map(row => ({path:row.path,bytes:row.bytes,sha256:row.sha256,source:row.source,sourceEvidence:row.provenance,sourceCustody:'must be adopted by restore owner before copy'})),
    copied:false, ...flags };
  return {profile:Buffer.from(JSON.stringify(profile,null,2)+'\n'),sources:sourceBytes,restoreMap:Buffer.from(JSON.stringify(restoreMap,null,2)+'\n')};
}
module.exports = Object.freeze({ derive, PROFILE_ID, PINS });
if (require.main === module) {
  const [candidateFile,mappingFile,output] = process.argv.slice(2);
  if (!candidateFile || !mappingFile || !output || !path.isAbsolute(output)) throw Error('Usage: node generate-media-profile.cjs <pinned-candidate.json> <pinned-mapping.json> <new-absolute-output-directory>');
  const base=path.resolve(__dirname,'..');
  readPinned(path.join(base,'resources/media-runtime-sources.json'),PINS.legacySources);
  const result=derive({candidateBytes:fs.readFileSync(candidateFile),mappingBytes:fs.readFileSync(mappingFile),legacyBytes:fs.readFileSync(path.join(base,'resources/media-runtime-dependencies.json')),workerSource:fs.readFileSync(path.join(base,'app/src/13bc-media-image-processor.js'),'utf8')});
  fs.mkdirSync(output); for (const [name,bytes] of [[PROFILE_ID+'.json',result.profile],[PROFILE_ID+'-sources.json',result.sources],['RESTORE-MAP.json',result.restoreMap]]) fs.writeFileSync(path.join(output,name),bytes,{flag:'wx'});
  console.log(JSON.stringify({profileId:PROFILE_ID,files:3251,bytes:396911379,outputs:Object.fromEntries(Object.entries(result).map(([key,value])=>[key,{bytes:value.length,sha256:sha(value)}])),payloadCopied:false,executionAuthorized:false,ready:false}));
}
