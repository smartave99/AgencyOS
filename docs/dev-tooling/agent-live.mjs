// Drives the real agent endpoints with the real Claude Code, the way the Copilot panel does.
const base = 'http://localhost:3000';
const { jwt } = await (await fetch(`${base}/auth/local-session`, { method: 'POST', headers: { 'x-agencyos-local-key': 'dev-local-key-0123456789abcdef' } })).json();
const headers = { auth: jwt, 'content-type': 'application/json' };
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, text }; }
};

// Use Claude Code for the agent job only.
const set = await call('PUT', '/agency/ai/settings', { tasks: { agent: { provider: 'claude-cli', model: 'haiku', thinking: 'off' } } });
console.log('settings', set.status, JSON.stringify(set.json?.tasks?.agent ?? set.json ?? set.text).slice(0, 200));
const models = await call('GET', '/agency/ai/models/claude-cli');
console.log('models', models.status, JSON.stringify(models.json?.models?.map((m) => `${m.id}[${(m.thinkingLevels || []).join(',')}]`)), models.json?.live, models.json?.note || '');

const history = [{ role: 'user', content: process.argv[2] || 'What needs my attention today? Then add a client called Nair Foods.' }];
for (let step = 0; step < 10; step += 1) {
  const r = await call('POST', '/agency/ai/agent/step', { messages: history, page: 'Dashboard (/agency/dashboard)' });
  if (r.status >= 300) { console.log('STEP ERROR', r.status, JSON.stringify(r.json ?? r.text).slice(0, 300)); break; }
  const { turn, assistant, ms } = r.json;
  history.push({ role: 'assistant', content: assistant });
  console.log(`step ${step + 1} (${(ms / 1000).toFixed(1)}s):`, turn.type, turn.tool || '', turn.type === 'tool' ? `ok=${turn.ok} ${turn.result.slice(0, 160)}` : turn.type === 'proposal' ? turn.summary : turn.text.slice(0, 400));
  if (turn.type === 'final') break;
  if (turn.type === 'tool') { history.push({ role: 'user', content: `TOOL RESULT (${turn.tool})${turn.ok ? '' : ' ERROR'}: ${turn.result}` }); continue; }
  // A proposal: approve it, as the person would with the button.
  const done = await call('POST', '/agency/ai/agent/act', { tool: turn.tool, args: turn.args });
  console.log('  approved ->', done.status, JSON.stringify(done.json).slice(0, 200));
  history.push({ role: 'user', content: `TOOL RESULT (${turn.tool}): The person approved and the change ${done.json?.ok ? 'was made' : 'FAILED'}: ${done.json?.result}` });
}
