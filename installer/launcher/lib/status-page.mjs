// The one page the launcher serves: progress while AgencyOS starts, then a control panel
// (open the app, local AI status, Telegram bot token, restart, stop). Plain HTML, no external
// resources, light and dark following the system setting. Every dynamic value is written with
// textContent, never innerHTML, because service errors can contain log text.

export function renderStatusPage({ token, version = '' }) {
  const safeToken = String(token).replace(/[^A-Za-z0-9_-]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="agencyos-token" content="${safeToken}">
<title>AgencyOS</title>
<style>
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--sub:#6e6e73;--line:#e5e5ea;--accent:#6d4aff;--accent-fg:#fff;--good:#1f9d55;--warn:#b7791f;--bad:#d1344b;--soft:#f0edff}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0f;--card:#17171c;--text:#f5f5f7;--sub:#9a9aa3;--line:#2a2a31;--accent:#8b6cff;--accent-fg:#0b0b0f;--good:#4cc38a;--warn:#e2b043;--bad:#ff6b81;--soft:#221d3a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI Variable","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:48px 20px 64px}
h1{font-size:30px;letter-spacing:-.02em;margin:0 0 4px;font-weight:650}
.lead{color:var(--sub);margin:0 0 24px;min-height:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:0 0 16px}
.card h2{font-size:13px;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.04em;margin:0 0 12px}
.row{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row .name{flex:1}
.row .state{color:var(--sub);font-size:13px}
.dot{width:18px;height:18px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:11px;color:#fff;background:var(--line)}
.dot.ready,.dot.done{background:var(--good)}
.dot.failed{background:var(--bad)}
.dot.restarting,.dot.starting{background:transparent;border:2px solid var(--line);border-top-color:var(--accent);animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dot.restarting,.dot.starting{animation:none;border-top-color:var(--accent)}}
button,.btn{font:inherit;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);padding:9px 14px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary,.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:transparent;font-weight:600}
button:focus-visible,.btn:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button[disabled]{opacity:.5;cursor:default}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin:10px 0 6px}
.bar>i{display:block;height:100%;background:var(--accent);width:0;transition:width .4s}
.muted{color:var(--sub);font-size:13px}
.err{color:var(--bad);font-size:13px;white-space:pre-wrap;margin:4px 0 0;max-height:160px;overflow:auto}
input[type=password],input[type=text]{font:inherit;width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
.field{display:flex;gap:8px;margin-top:8px}
.ok{color:var(--good)}
ul.reasons{margin:8px 0 0;padding-left:18px;color:var(--sub);font-size:13px}
.path{word-break:break-all;margin:2px 0 12px}
label.lbl{display:block;font-size:13px;color:var(--sub);margin:14px 0 4px}
details{margin-top:14px}
summary{cursor:pointer;color:var(--sub);font-size:13px}
.msg{font-size:13px;min-height:18px;margin-top:4px;color:var(--sub)}
.msg.bad{color:var(--bad)}
.check{display:flex;align-items:center;gap:8px;margin:10px 0 0;font-size:14px}
footer{color:var(--sub);font-size:12px;margin-top:28px;text-align:center}
</style>
</head>
<body>
<main>
  <h1 id="title">Starting AgencyOS</h1>
  <p class="lead" id="lead">Getting everything ready. The first start takes a minute or two.</p>

  <section class="card" id="open-card" hidden>
    <div class="actions"><a class="btn primary" id="open" href="#">Open AgencyOS</a></div>
    <p class="muted" id="open-hint" style="margin:10px 0 0"></p>
  </section>

  <section class="card"><h2>Services</h2><div id="services" aria-live="polite"></div></section>

  <section class="card" id="ai-card">
    <h2>Local AI</h2>
    <div id="ai-line">Checking this computer…</div>
    <div class="bar" id="ai-bar" hidden><i id="ai-fill"></i></div>
    <div class="muted" id="ai-detail"></div>
    <ul class="reasons" id="ai-reasons"></ul>
  </section>

  <section class="card">
    <h2>Telegram bot (optional)</h2>
    <div class="muted" id="tg-line">Paste the token from @BotFather to let AgencyOS post to chats whose admins have authorized it.</div>
    <form class="field" id="tg-form" autocomplete="off">
      <input type="password" id="tg-token" placeholder="123456789:AA…" aria-label="Telegram bot token" spellcheck="false">
      <button class="primary" id="tg-save" type="submit">Save</button>
    </form>
    <div class="muted" id="tg-msg" role="status"></div>
  </section>

  <section class="card" id="storage-card">
    <h2>Storage</h2>
    <div id="st-summary">
      <div class="muted">Your data: database, uploads, logs</div>
      <div class="path" id="st-data"></div>
      <div class="muted">Local AI engine and models</div>
      <div class="path" id="st-ai"></div>
      <div class="actions"><button id="st-open">Change location…</button></div>
      <p class="muted" id="st-locked" hidden style="margin:10px 0 0">The location is fixed by the AGENCYOS_DATA setting on this computer.</p>
    </div>
    <form id="st-form" hidden autocomplete="off">
      <label class="lbl" for="st-data-in">Data folder</label>
      <div class="field"><input type="text" id="st-data-in" spellcheck="false" placeholder="D:\\AgencyOS"><button type="button" id="st-data-browse" hidden>Browse…</button></div>
      <div class="msg" id="st-data-msg" role="status"></div>
      <details id="st-adv">
        <summary>Advanced: keep the AI models somewhere else</summary>
        <label class="check"><input type="checkbox" id="st-keep"> Keep the AI files with my data</label>
        <label class="lbl" for="st-ai-in">AI folder</label>
        <div class="field"><input type="text" id="st-ai-in" spellcheck="false" placeholder="E:\\AgencyOS-AI"><button type="button" id="st-ai-browse" hidden>Browse…</button></div>
        <div class="msg" id="st-ai-msg" role="status"></div>
      </details>
      <div class="msg" id="st-plan"></div>
      <div class="actions"><button class="primary" id="st-go" type="submit" disabled>Move…</button><button type="button" id="st-cancel">Cancel</button></div>
    </form>
    <div id="st-progress" hidden>
      <div id="st-phase"></div>
      <div class="bar"><i id="st-fill"></i></div>
      <div class="muted" id="st-detail">Keep this computer on. AgencyOS restarts by itself when the move is done.</div>
    </div>
    <div id="st-left" hidden>
      <p class="muted" style="margin:14px 0 6px">The old copy is still on this computer, using space:</p>
      <div class="path" id="st-left-list"></div>
      <div class="actions"><button id="st-clean">Delete the old copy…</button></div>
    </div>
    <div class="err" id="st-fail"></div>
  </section>

  <section class="card">
    <h2>This computer</h2>
    <div class="muted" id="hw"></div>
    <div class="actions">
      <button id="restart">Restart everything</button>
      <button id="stop">Stop AgencyOS</button>
    </div>
    <p class="muted" id="paths" style="margin:12px 0 0"></p>
  </section>

  <footer>AgencyOS ${version ? 'v' + String(version).replace(/[^0-9A-Za-z.\-+]/g, '') : ''} · created by NextGen OS · runs only on this computer</footer>
</main>
<script>
(function(){
  var token = document.querySelector('meta[name=agencyos-token]').content;
  var $ = function(id){ return document.getElementById(id); };
  var STATE = {pending:'Waiting',starting:'Starting…',ready:'Running',restarting:'Restarting…',failed:'Needs attention',done:'Done',stopped:'Stopped',idle:'Not started'};
  var autoOpen = /[?&]open=1/.test(location.search);
  var opened = false;
  function text(el, s){ el.textContent = s == null ? '' : String(s); }
  function api(path, method, body){
    return fetch(path, {method: method || 'GET', headers: {'X-AgencyOS-Token': token, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if(!r.ok) throw new Error(j.error || ('Request failed ('+r.status+')')); return j; }); });
  }
  function bytes(n){ if(!n) return '0 MB'; return n > 1073741824 ? (n/1073741824).toFixed(1)+' GB' : Math.round(n/1048576)+' MB'; }
  function renderServices(list){
    var box = $('services'); box.textContent = '';
    list.forEach(function(s){
      var row = document.createElement('div'); row.className = 'row';
      var dot = document.createElement('span'); dot.className = 'dot ' + s.state; if(s.state==='ready'||s.state==='done') dot.textContent = '✓'; if(s.state==='failed') dot.textContent = '!';
      var name = document.createElement('span'); name.className = 'name'; text(name, s.label + (s.required ? '' : ' (optional)'));
      var st = document.createElement('span'); st.className = 'state'; text(st, s.message && s.state==='starting' ? s.message : (STATE[s.state] || s.state));
      row.appendChild(dot); row.appendChild(name); row.appendChild(st);
      box.appendChild(row);
      if(s.error){ var e = document.createElement('div'); e.className = 'err'; text(e, s.error); box.appendChild(e); }
    });
  }
  function renderAi(ai){
    var line = ai.message || '';
    if(ai.phase==='ready'){
      var m = ai.models || {}, parts = [];
      if(m.embedding) parts.push('Search: ' + m.embedding.id);
      if(m.text) parts.push('Copy suggestions: ' + m.text.id + (m.text.tokensPerSecond ? ' (' + m.text.tokensPerSecond + ' tokens/s)' : ''));
      line = parts.length ? parts.join(' · ') : 'Ready';
    } else if(ai.phase==='off'){ line = 'Off. ' + (ai.message || ''); }
    text($('ai-line'), line || 'Checking this computer…');
    var p = ai.progress, bar = $('ai-bar');
    bar.hidden = !(p && p.fraction >= 0 && ai.phase !== 'ready');
    if(!bar.hidden){ $('ai-fill').style.width = Math.round(Math.max(0,Math.min(1,p.fraction))*100)+'%'; text($('ai-detail'), bytes(p.received) + (p.total ? ' of ' + bytes(p.total) : '') + (p.bytesPerSecond ? ' · ' + (p.bytesPerSecond/1048576).toFixed(1) + ' MB/s' : '')); }
    else text($('ai-detail'), ai.tier && ai.label ? 'Tier: ' + ai.label : '');
    var ul = $('ai-reasons'); ul.textContent = '';
    (ai.reasons || []).slice(0,4).forEach(function(r){ var li = document.createElement('li'); text(li, r); ul.appendChild(li); });
  }
  var current = {data: '', ai: '', custom: false};
  var checkTimer = null, checkSeq = 0, formOpen = false, lastPlan = null;
  function storageRequest(){
    var d = $('st-data-in').value.trim(), a = $('st-ai-in').value.trim(), r = {};
    if(d && d !== current.data) r.dataRoot = d;
    if($('st-keep').checked) r.keepWithData = true; else if(a && a !== current.ai) r.aiRoot = a;
    return r;
  }
  function showFieldErrors(fields, plan){
    text($('st-data-msg'), fields.dataRoot || ''); $('st-data-msg').className = 'msg' + (fields.dataRoot ? ' bad' : '');
    text($('st-ai-msg'), fields.aiRoot || ''); $('st-ai-msg').className = 'msg' + (fields.aiRoot ? ' bad' : '');
    if(fields.aiRoot) $('st-adv').open = true;
    var line = '';
    if(plan && plan.ok && plan.changes){
      line = 'Needs about ' + bytes(plan.needBytes) + ' of free space' + (plan.freeBytes != null ? ' (' + bytes(plan.freeBytes) + ' free)' : '') + '. ' + plan.jobs.map(function(j){ return j.label + ': ' + bytes(j.bytes); }).join(' · ');
    } else if(plan && plan.ok && !plan.changes){ line = 'Those are the folders AgencyOS already uses.'; }
    text($('st-plan'), line);
    $('st-go').disabled = !(plan && plan.ok && plan.changes);
  }
  function runCheck(){
    var seq = ++checkSeq, r = storageRequest();
    if(!r.dataRoot && !r.aiRoot && !r.keepWithData){ lastPlan = null; showFieldErrors({}, null); return; }
    text($('st-plan'), 'Checking…'); $('st-go').disabled = true;
    api('/api/storage/check','POST',r).then(function(plan){ if(seq !== checkSeq) return; lastPlan = plan; showFieldErrors(plan.errors || {}, plan); }).catch(function(e){ if(seq === checkSeq) text($('st-plan'), e.message); });
  }
  function scheduleCheck(){ clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, 500); }
  function openForm(){
    formOpen = true; $('st-form').hidden = false; $('st-summary').hidden = true;
    $('st-data-in').value = current.data; $('st-ai-in').value = current.custom ? current.ai : ''; $('st-keep').checked = !current.custom;
    $('st-ai-in').disabled = $('st-keep').checked; $('st-adv').open = current.custom;
    showFieldErrors({}, null); $('st-data-in').focus();
  }
  function closeForm(){ formOpen = false; $('st-form').hidden = true; $('st-summary').hidden = false; clearTimeout(checkTimer); checkSeq++; }
  function pick(inputId){ var el = $(inputId); window.agencyos.pickFolder(el.value).then(function(p){ if(p){ el.value = p; if(inputId === 'st-ai-in') $('st-keep').checked = false; $('st-ai-in').disabled = $('st-keep').checked; runCheck(); } }); }
  function renderStorage(st){
    if(!st) return;
    current = {data: st.dataRoot, ai: st.aiRoot, custom: !!st.customAi};
    text($('st-data'), st.dataRoot);
    text($('st-ai'), st.customAi ? st.aiRoot : 'With your data (' + st.aiRoot + ')');
    var mv = st.move, moving = !!(mv && mv.active);
    $('st-open').hidden = !!st.locked; $('st-locked').hidden = !st.locked;
    $('st-progress').hidden = !moving;
    if(moving){
      if(formOpen) closeForm();
      $('st-summary').hidden = true;
      text($('st-phase'), mv.message || 'Working…');
      var frac = mv.totalBytes ? Math.max(0, Math.min(1, mv.copiedBytes / mv.totalBytes)) : 0;
      $('st-fill').style.width = Math.round(frac * 100) + '%';
      text($('st-detail'), (mv.totalBytes ? bytes(mv.copiedBytes) + ' of ' + bytes(mv.totalBytes) + '. ' : '') + 'Keep this computer on. AgencyOS restarts by itself when the move is done.');
    } else if(!formOpen){ $('st-summary').hidden = false; }
    text($('st-fail'), mv && mv.phase === 'failed' ? 'The move did not finish and nothing was changed. ' + (mv.message || '') : '');
    var left = st.leftovers || [];
    $('st-left').hidden = !left.length || moving;
    text($('st-left-list'), left.map(function(l){ return l.path + (l.bytes ? ' (' + bytes(l.bytes) + ')' : ''); }).join('\\n'));
    $('st-left-list').style.whiteSpace = 'pre-line';
  }
  function render(s){
    renderStorage(s.storage);
    var ready = s.ready;
    text($('title'), ready ? 'AgencyOS is ready' : (s.attention ? 'AgencyOS needs attention' : 'Starting AgencyOS'));
    text($('lead'), ready ? 'Everything is running on this computer.' : (s.attention ? 'Something did not start. Details are below; "Restart everything" tries again.' : 'Getting everything ready. The first start takes a minute or two.'));
    $('open-card').hidden = !ready;
    $('open').href = s.url;
    if(ready){
      if(autoOpen && !opened){ opened = true; text($('open-hint'), 'Opening AgencyOS…'); setTimeout(function(){ location.href = s.url; }, 1200); }
      else if(!autoOpen) text($('open-hint'), s.url);
    }
    renderServices(s.services);
    renderAi(s.ai || {});
    text($('tg-line'), s.telegram && s.telegram.configured ? 'A bot token is saved. Paste a new one to replace it, or leave the box empty and press Save to remove it.' : 'Paste the token from @BotFather to let AgencyOS post to chats whose admins have authorized it.');
    var hw = s.ai && s.ai.hardware; if(hw){ text($('hw'), [hw.os, hw.cpu, hw.threads ? hw.threads + ' threads' : '', hw.ramGB ? hw.ramGB + ' GB memory' : '', hw.gpu || 'no dedicated GPU'].filter(Boolean).join(' · ')); }
    text($('paths'), 'Your data: ' + s.dataDir);
  }
  function poll(){ fetch('/api/status').then(function(r){ return r.json(); }).then(render).catch(function(){ text($('lead'), 'AgencyOS is not running. Start it from the Start menu.'); }).then(function(){ setTimeout(poll, 1500); }); }
  $('tg-form').addEventListener('submit', function(ev){
    ev.preventDefault();
    var v = $('tg-token').value.trim();
    text($('tg-msg'), 'Saving…');
    api('/api/telegram','POST',{token:v}).then(function(r){ $('tg-token').value=''; text($('tg-msg'), r.configured ? 'Saved. The bot is connecting.' : 'Removed.'); }).catch(function(e){ text($('tg-msg'), e.message); });
  });
  $('st-open').addEventListener('click', openForm);
  $('st-cancel').addEventListener('click', closeForm);
  ['st-data-in','st-ai-in'].forEach(function(id){ $(id).addEventListener('input', scheduleCheck); });
  $('st-keep').addEventListener('change', function(){ $('st-ai-in').disabled = this.checked; runCheck(); });
  if(window.agencyos && window.agencyos.pickFolder){
    $('st-data-browse').hidden = false; $('st-ai-browse').hidden = false;
    $('st-data-browse').addEventListener('click', function(){ pick('st-data-in'); });
    $('st-ai-browse').addEventListener('click', function(){ pick('st-ai-in'); });
  }
  $('st-form').addEventListener('submit', function(ev){
    ev.preventDefault();
    if(!lastPlan || !lastPlan.ok || !lastPlan.changes) return;
    var where = lastPlan.jobs.map(function(j){ return j.label + ' to ' + j.to; }).join('\\n');
    if(!confirm('Move AgencyOS to its new location?\\n\\n' + where + '\\n\\nAgencyOS stops while the files are copied, then starts again by itself. Nothing is deleted from the old place; you can remove the old copy afterwards.')) return;
    $('st-go').disabled = true;
    api('/api/storage/move','POST',storageRequest()).then(function(){ closeForm(); }).catch(function(e){ text($('st-plan'), e.message); $('st-go').disabled = false; });
  });
  $('st-clean').addEventListener('click', function(){
    if(!confirm('Delete the old copy?\\n\\nThis frees the space but cannot be undone. AgencyOS is already running from the new location.')) return;
    this.disabled = true; var b = this;
    api('/api/storage/cleanup','POST',{}).catch(function(e){ text($('st-fail'), e.message); }).then(function(){ b.disabled = false; });
  });
  $('restart').addEventListener('click', function(){ this.disabled = true; var b = this; api('/api/restart','POST',{}).catch(function(){}).then(function(){ b.disabled = false; }); });
  $('stop').addEventListener('click', function(){ if(!confirm('Stop AgencyOS? Scheduled campaigns will not be sent while it is stopped.')) return; api('/api/shutdown','POST',{}).catch(function(){}); text($('title'),'AgencyOS stopped'); text($('lead'),'You can close this tab. Start it again from the Start menu.'); });
  poll();
})();
</script>
</body>
</html>`;
}
