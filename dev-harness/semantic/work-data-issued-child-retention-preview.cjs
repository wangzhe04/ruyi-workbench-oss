'use strict';
// Research-only transform. Applying to the live app requires the coordinated source window.
function transform(source) {
  const edits = [
    ['async function migrationCapsuleBroker() {', 'const migrationCapsuleIssuedChildren = new Set();\nasync function migrationCapsuleBroker() {'],
    ["  try { code?.observe(child); } catch { /* Optional code reuse cannot replace the original child/error pipeline. */ }", "  migrationCapsuleIssuedChildren.add(child);\n  try {\n    child.once('close', () => migrationCapsuleIssuedChildren.delete(child));\n  try { code?.observe(child); } catch { /* Optional code reuse cannot replace the original child/error pipeline. */ }"],
    ["    if (absent) { firstError ||= failure('native_unavailable', cause); finish(firstError); }", "    if (absent) { migrationCapsuleIssuedChildren.delete(child); firstError ||= failure('native_unavailable', cause); finish(firstError); }"],
    ["  return Object.freeze({ command, close });\n}\nfunction migrationCapsulePortableShape", "  return Object.freeze({ command, close });\n  } catch (cause) {\n    migrationCapsuleBroker.helperMayStillRun = true;\n    throw failure('native_helper_uncertain', cause, true);\n  }\n}\nfunction migrationCapsulePortableShape"]
  ];
  for (const [from,to] of edits) {
    if (source.split(from).length !== 2) throw new Error('boundary drift: '+from.slice(0, 60));
    source=source.replace(from,to);
  }
  return source;
}
module.exports={transform};
