// Minimal live probe: dump the RAW DeepSeek web_search_call item structure so we can see exactly
// where the query text lives (the workbench parser currently misses it → UI shows "服务端搜索").
// Usage: node dev-harness/deepseek-ws-shape.js <DEEPSEEK_API_KEY> ["query"]
'use strict';
const KEY = process.argv[2];
const QUERY = process.argv[3] || 'DeepSeek V4 最新模型';
if (!KEY) { console.error('Usage: node dev-harness/deepseek-ws-shape.js <DEEPSEEK_API_KEY> ["query"]'); process.exit(2); }
(async () => {
  const res = await fetch('https://api.deepseek.com/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      instructions: '你是一个联网助手。用户给你查询词时，先用 web_search 搜索，再基于搜索结果简洁回答。',
      input: QUERY,
      tools: [{ type: 'web_search' }],
      stream: true,
    }),
  });
  if (!res.ok || !res.body) { console.log('HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 300)); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let e; try { e = JSON.parse(payload); } catch { continue; }
      if (e.type === 'response.output_item.added' && e.item && e.item.type === 'web_search_call') {
        console.log('=== output_item.added (web_search_call) — FULL ITEM ===');
        console.log(JSON.stringify(e.item, null, 2));
      }
      if (e.type === 'response.output_item.done' && e.item && e.item.type === 'web_search_call') {
        console.log('=== output_item.done (web_search_call) — FULL ITEM ===');
        console.log(JSON.stringify(e.item, null, 2));
        console.log('=== 顶层字段 keys: ' + Object.keys(e.item).join(', '));
        if (e.item.output && typeof e.item.output === 'object') console.log('=== output keys: ' + Object.keys(e.item.output).join(', '));
        if (e.item.status) console.log('=== status: ' + e.item.status);
      }
      if (e.type === 'response.completed') { console.log('=== DONE ==='); return; }
    }
  }
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
