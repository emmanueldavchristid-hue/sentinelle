import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchIntent } from './baoule.js';
import { BAOULE_PHRASES, bciNumber, type BaouleIntent } from './baoule-phrases.js';
import { config } from './config.js';

/**
 * `pnpm baoule:check` : essai RÉEL du service local de parole en baoulé (tools/baoule/serveur.py doit être lancé).
 * Pour chaque question de référence : la voix la prononce, l'écoute la retranscrit, et la règle de ressemblance doit
 * retrouver la bonne question. Puis les phrases de réponse sont prononcées et gardées dans data/baoule/essais pour écoute.
 *
 * Ce que cet essai prouve : que la chaîne tourne sur ce poste, et en combien de temps. Ce qu'il ne prouve pas : que le
 * baoulé est juste, ni qu'une vraie voix sera comprise (la voix de synthèse est plus régulière qu'une personne).
 */
const url = config.baoule.url;
const outDir = resolve(import.meta.dirname, '../../../data/baoule/essais');
const INTENTS: BaouleIntent[] = ['situation', 'changes', 'missing', 'beacons'];

async function tts(text: string): Promise<{ wav: Buffer; ms: number }> {
  const t = Date.now();
  const r = await fetch(`${url}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`voix : HTTP ${r.status} ${await r.text()}`);
  return { wav: Buffer.from(await r.arrayBuffer()), ms: Date.now() - t };
}
async function stt(wav: Buffer): Promise<{ text: string; ms: number }> {
  const t = Date.now();
  const r = await fetch(`${url}/stt`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(wav), signal: AbortSignal.timeout(180_000) });
  const j = (await r.json()) as { text?: string; error?: string };
  if (!r.ok || typeof j.text !== 'string') throw new Error(`écoute : HTTP ${r.status} ${j.error ?? ''}`);
  return { text: j.text, ms: Date.now() - t };
}
const seconds = (wav: Buffer) => (wav.length - 44) / 2 / 24000;

let health: { stt?: boolean; tts?: boolean; errors?: Record<string, string> };
try {
  health = (await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })).json()) as typeof health;
} catch {
  console.log(`Service local de parole injoignable sur ${url}. Lancez : data\\baoule\\venv\\Scripts\\python.exe tools\\baoule\\serveur.py`);
  process.exit(1);
}
console.log(`Service local : écoute ${health.stt ? 'prête' : 'ABSENTE'}, voix ${health.tts ? 'prête' : 'ABSENTE'}`, health.errors && Object.keys(health.errors).length ? health.errors : '');
if (!health.stt || !health.tts) process.exit(1);
console.log(`Phrases : ${BAOULE_PHRASES.validated ? 'validées par un locuteur' : 'PREMIER JET, validé par aucun locuteur'}\n`);
mkdirSync(outDir, { recursive: true });

let ok = 0;
let total = 0;
console.log('1. Questions : prononcées par la voix, retranscrites par l’écoute, rapprochées par la règle');
for (const intent of INTENTS) {
  for (const [i, q] of BAOULE_PHRASES.questions[intent].entries()) {
    total++;
    const said = await tts(q);
    writeFileSync(resolve(outDir, `question-${intent}-${i + 1}.wav`), said.wav);
    const heard = await stt(said.wav);
    const m = matchIntent(heard.text, BAOULE_PHRASES.questions);
    if (m.intent === intent) ok++;
    console.log(`  ${m.intent === intent ? 'ok ' : 'NON'} ${intent.padEnd(9)} « ${q} »\n      entendu « ${heard.text} » → ${m.intent} (${m.score.toFixed(2)}) | voix ${(said.ms / 1000).toFixed(1)} s pour ${seconds(said.wav).toFixed(1)} s de son, écoute ${(heard.ms / 1000).toFixed(1)} s`);
  }
}
console.log(`  ${ok}/${total} questions retrouvées\n`);

console.log('2. Réponses : prononcées et gardées pour écoute par un locuteur');
const A = BAOULE_PHRASES.answers;
const samples: [string, string, string][] = [
  ['reponse-situation', `${A.animals.bci.replace('{N}', bciNumber(8)!)} ${A.changes.bci.replace('{N}', bciNumber(5)!)} ${A.missing.bci.replace('{N}', bciNumber(11)!)} ${A.screen.bci}`, '8 animaux, 5 nouveautés, 11 informations manquantes'],
  ['reponse-balise', `${A.beaconOut.bci.replace('{N}', bciNumber(57)!)} ${A.screen.bci}`, 'un animal s’est éloigné, 57 mètres'],
  ['reponse-non-comprise', A.unknown.bci, 'je n’ai pas compris'],
];
for (const [name, text, fr] of samples) {
  const said = await tts(text);
  writeFileSync(resolve(outDir, `${name}.wav`), said.wav);
  console.log(`  ${name}.wav (${fr}) : ${(said.ms / 1000).toFixed(1)} s de calcul pour ${seconds(said.wav).toFixed(1)} s de son\n      « ${text} »`);
}
console.log(`\nFichiers dans ${outDir}`);
process.exit(ok === total ? 0 : 2);
