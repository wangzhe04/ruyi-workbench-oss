// Raw connectivity probe against the real DeepSeek API. Key passed as argv (not hardcoded).
const KEY = process.argv[2];
const BASE = 'https://api.deepseek.com/v1';
const MODEL = process.argv[3] || 'deepseek-chat';
(async () => {
  try {
    const mr = await fetch(BASE + '/models', { headers: { authorization: 'Bearer ' + KEY } });
    console.log('MODELS status', mr.status);
    const mj = await mr.json().catch(() => null);
    console.log('MODELS', JSON.stringify(mj));
  } catch (e) { console.log('MODELS ERR', e.message); }

  try {
    const cr = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL, stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'user', content: '用一句中文介绍你自己，并明确说出你的模型名称。' }],
      }),
    });
    console.log('CHAT status', cr.status, 'model', MODEL);
    if (!cr.ok) { console.log('CHAT body', (await cr.text()).slice(0, 800)); return; }
    const reader = cr.body.getReader(); const dec = new TextDecoder();
    let buf = '', text = '', reason = '', usage = null;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl); buf = buf.slice(nl + 1); line = line.replace(/\r$/, '').trim();
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim(); if (d === '[DONE]') continue;
        try {
          const e = JSON.parse(d);
          if (e.usage) usage = e.usage;
          const del = e.choices && e.choices[0] && e.choices[0].delta;
          if (del) { if (del.content) text += del.content; if (del.reasoning_content) reason += del.reasoning_content; }
        } catch { /* ignore */ }
      }
    }
    console.log('CHAT reasoning:', reason ? reason.slice(0, 200) : '(none)');
    console.log('CHAT text:', text);
    console.log('CHAT usage:', JSON.stringify(usage));
  } catch (e) { console.log('CHAT ERR', e.message); }
})();
