// A stand-in for the launcher's control surface: the real status server with a fixed status, so the
// app's System settings can be exercised in a browser without the whole Windows install.
import { createStatusServer } from '/home/user/AgencyOS/installer/launcher/lib/status-server.mjs';
const calls = [];
const status = {
  app: 'AgencyOS', version: '1.3.0', ready: true, attention: false, url: 'http://localhost:4200',
  services: [
    { name: 'postgres', label: 'Database', required: true, state: 'ready' },
    { name: 'redis', label: 'Cache', required: true, state: 'ready' },
    { name: 'temporal', label: 'Workflow engine', required: true, state: 'ready' },
    { name: 'migrate', label: 'Database updates', required: true, state: 'done' },
    { name: 'backend', label: 'AgencyOS server', required: true, state: 'ready' },
    { name: 'orchestrator', label: 'Background workflows', required: false, state: 'ready' },
    { name: 'frontend', label: 'AgencyOS app', required: true, state: 'ready' },
    { name: 'ollama', label: 'Local AI engine', required: false, state: 'ready' },
  ],
  ai: { phase: 'ready', tier: 'balanced', label: 'Balanced', models: { embedding: { id: 'embeddinggemma' }, text: { id: 'gemma4:e2b', tokensPerSecond: 6.8 } }, reasons: ['Balanced text model gemma4:e2b fits 15.6 GB memory, 8 processor threads.'], hardware: { os: 'Microsoft Windows 11 Home Single Language 10.0.26100', cpu: 'Snapdragon(R) X - X126100', threads: 8, ramGB: 15.6, gpu: 'Qualcomm(R) Adreno(TM) X1-45' } },
  telegram: { configured: false },
  storage: { dataRoot: 'D:\\Abdul Test\\Data', aiRoot: 'D:\\Abdul Test\\Model', customAi: true, defaultRoot: 'C:\\Users\\a\\AppData\\Local\\AgencyOS', locked: false, move: null, leftovers: [] },
  dataDir: 'D:\\Abdul Test\\Data', logsDir: 'D:\\Abdul Test\\Data\\logs', ports: { frontend: 4200, backend: 3000 }, pid: 1,
};
const ai = { auto: false, engine: { installed: false, running: false, version: null, external: false }, installed: [], download: null, engineTask: null };
const sizes = { 'gemma3:1b': 0.75, 'gemma3:4b': 3.12, 'gemma4:e2b': 4.27, embeddinggemma: 0.58, 'all-minilm': 0.04 };
const suggestions = [{ id: 'gemma4:e2b', label: 'Recommended for this computer', kind: 'text', sizeGB: 4.27, recommended: true }, { id: 'embeddinggemma', label: 'Recommended for search', kind: 'embedding', sizeGB: 0.58, recommended: true }, { id: 'gemma3:4b', label: 'Balanced', kind: 'text', sizeGB: 3.12, recommended: false }, { id: 'gemma3:1b', label: 'Light', kind: 'text', sizeGB: 0.75, recommended: false }, { id: 'all-minilm', label: 'all-MiniLM', kind: 'embedding', sizeGB: 0.04, recommended: false }];
const server = createStatusServer({
  port: 4999, token: 'dev-launcher-token', version: '1.3.0', getStatus: () => status, tail: () => null,
  actions: {
    restart: async () => calls.push('restart'), shutdown: () => {}, retryAi: () => calls.push('retryAi'),
    setTelegramToken: async () => {},
    checkStorage: async (req) => { calls.push(['check', req]); return req.dataRoot && req.dataRoot.includes('bad') ? { ok: false, errors: { dataRoot: 'That folder is not writable.' } } : { ok: true, changes: true, needBytes: 3221225472, freeBytes: 64424509440, jobs: [{ label: 'Your data', bytes: 2147483648, to: req.dataRoot || 'x' }] }; },
    moveStorage: async (req) => { calls.push(['move', req]); },
    cleanupStorage: async () => ({}),
    aiModels: async () => ({ ...ai, suggestions, listError: null, freeDiskGB: 120, modelsDir: 'D:\\Abdul Test\\Model', installed: ai.installed.map((m) => ({ name: m, sizeBytes: (sizes[m] || 1) * 1073741824, modifiedAt: null, parameterSize: m.includes('4b') ? '4B' : null, quantization: 'Q4_K_M', roles: m === 'gemma4:e2b' ? ['copy'] : m === 'embeddinggemma' ? ['search'] : [] })) }),
    aiSetAuto: (e) => { ai.auto = e; return { auto: e }; },
    aiDownload: (model) => { ai.download = { model, state: 'downloading', fraction: 0, received: 0, total: (sizes[model] || 1) * 1073741824, bytesPerSecond: 18e6 }; const t = setInterval(() => { ai.download.fraction += 0.12; ai.download.received = ai.download.fraction * ai.download.total; if (ai.download.fraction >= 1) { clearInterval(t); ai.installed.push(model); ai.download = { model, state: 'done', fraction: 1 }; } }, 400); return { started: true }; },
    aiCancel: () => { ai.download = ai.download && { model: ai.download.model, state: 'cancelled', error: null }; return { cancelled: true }; },
    aiDelete: async (model) => { ai.installed = ai.installed.filter((m) => m !== model); return { deleted: model }; },
    aiEngine: (action) => { ai.engineTask = { action, state: 'working', message: action === 'install' ? 'Setting up the local AI engine' : 'Working' }; setTimeout(() => { if (action === 'stop') ai.engine.running = false; else { ai.engine = { installed: true, running: true, version: '0.40.3', external: false }; } ai.engineTask = { action, state: 'done', message: '' }; }, 1500); return { started: true }; },
    aiTry: async (model) => ({ ok: true, kind: model.includes('embed') ? 'embedding' : 'text', sample: 'OK', tokensPerSecond: 6.8, seconds: 1.4, dimensions: 768 }),
  },
});
await server.listen();
console.log('fake launcher on 4999');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => { if (calls.length) { console.log(JSON.stringify(calls.splice(0))); } }, 500);
