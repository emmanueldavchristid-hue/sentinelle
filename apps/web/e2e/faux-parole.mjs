// Faux service local de parole en baoulé, pour le test de navigateur `baoule-faux.spec.ts` (BAOULE=faux).
// Il ne charge aucun modèle : il « entend » le texte qu'on lui règle par /controle, et « dit » un son de test (une note).
// Il sert à vérifier l'écran, la réponse en deux temps et la lecture du son dans le navigateur ; il ne dit rien de la
// justesse du baoulé ni de la qualité des vrais modèles (tools/baoule/serveur.py, essai réel : BAOULE=1).
import { createServer } from 'node:http';

const port = Number(process.env.FAUX_PAROLE_PORT ?? 3107);
let state = { hears: 'ngue like uflɛ yɛ ɔ juli', silence: false, sttDelayMs: 0, ttsDelayMs: 0, ttsFails: false };
const said = [];
const warmed = [];

/** Une note d'une seconde et demie, WAV 24 kHz mono 16 bits : un vrai son, que le navigateur joue. */
function tone(seconds = 1.5, rate = 24000) {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 330 * i) / rate)), 44 + i * 2);
  return b;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

createServer(async (req, res) => {
  const json = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const data = await body(req);
  if (req.method === 'GET' && req.url === '/health') return json(200, { stt: true, tts: true, errors: {}, engine: 'faux moteur (test de navigateur)' });
  if (req.method === 'GET' && req.url === '/dit') return json(200, { said, warmed });
  if (req.method === 'POST' && req.url === '/controle') {
    state = { ...state, ...JSON.parse(data.toString() || '{}') };
    if (JSON.parse(data.toString() || '{}').reset) said.length = warmed.length = 0;
    return json(200, state);
  }
  if (req.method === 'POST' && req.url === '/stt') {
    await wait(state.sttDelayMs);
    return json(200, { text: state.silence ? '' : state.hears, silence: state.silence, audioSeconds: data.length / 32000, computeSeconds: state.sttDelayMs / 1000, engine: 'faux moteur (test de navigateur)' });
  }
  if (req.method === 'POST' && req.url === '/warm') {
    warmed.push(...(JSON.parse(data.toString()).texts ?? []));
    return json(200, { queued: 0, warming: 0 });
  }
  if (req.method === 'POST' && req.url === '/tts') {
    await wait(state.ttsDelayMs);
    if (state.ttsFails) return json(503, { error: 'voix en panne (test)' });
    said.push(JSON.parse(data.toString()).text);
    const wav = tone();
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
    return res.end(wav);
  }
  return json(404, { error: 'inconnu' });
}).listen(port, '127.0.0.1', () => console.log(`faux service de parole : http://127.0.0.1:${port}`));
