// Ruyi's opt-in Kimi ACP compatibility loader.
//
// Kimi Code 0.37.x advertises the ACP terminal capability but internally rejects
// every process other than its interactive Bash wrapper. Its native Glob/Grep
// tools consequently fail before they can issue ACP terminal/create. Ruyi
// implements the full terminal lifecycle and applies its normal workspace and
// permission guards to every request, so the restriction is redundant here.
//
// This loader never writes to the user's Kimi installation. It only transforms
// the exact upstream helper when Ruyi explicitly enables it for an ACP child.
const enabled = process.env.RUYI_KIMI_ACP_COMPAT === '1';
const original = `function isBashToolInvocation(args, options) {
\treturn args.length === 2 && args[0] === "-c" && options?.env?.["NO_COLOR"] === "1" && options?.env?.["TERM"] === "dumb";
}`;
const replacement = `function isBashToolInvocation(args, options) {
\treturn Array.isArray(args);
}`;

function isKimiEntry(url) {
  try {
    return /\/@moonshot-ai\/kimi-code\/dist\/main\.mjs(?:[?#]|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!enabled || !isKimiEntry(url) || loaded.format !== 'module') return loaded;
  const source = typeof loaded.source === 'string'
    ? loaded.source
    : Buffer.from(loaded.source || '').toString('utf8');
  if (!source.includes(original)) {
    process.stderr.write('[Ruyi Kimi ACP compat] unknown-helper: exact isBashToolInvocation source was not found; no source patch was applied\n');
    return loaded;
  }
  process.stderr.write('[Ruyi Kimi ACP compat] patch-applied: exact isBashToolInvocation source matched\n');
  return { ...loaded, source: source.replace(original, replacement) };
}
