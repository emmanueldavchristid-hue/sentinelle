import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AssistantReply, BaouleReply, BaouleStatus, BeaconsData, ChangesData, MissingData, SituationData, ToolResult } from '@sentinelle/contracts';
import { answerDirect, type AskInput } from './assistant.js';
import { BAOULE_PHRASES, bciNumber, type BaouleAnswerKey, type BaouleIntent } from './baoule-phrases.js';
import type { FarmTools } from './farm.js';
import { HttpError, type User } from './http.js';

/**
 * Note vocale en baoulé (demande de Yvan, 22/11) : l'utilisateur parle baoulé, l'application répond à la voix en baoulé.
 * L'interface écrite reste en français.
 *
 * Aucun service en ligne ne sait le baoulé (essais réels, docs/BAOULE.md). La chaîne est donc locale et volontairement étroite :
 *   1. écoute  : un modèle ouvert transcrit la note vocale en baoulé (service local `tools/baoule/serveur.py`) ;
 *   2. sens    : la transcription est RAPPROCHÉE de quelques questions connues (règle de ressemblance, pas de traduction) ;
 *   3. faits   : la lecture des données est celle du français (`answerDirect`), affichée à l'écran avec ses preuves ;
 *   4. réponse : un gabarit baoulé fixe, où seuls les nombres changent, écrits en toutes lettres par une règle ;
 *   5. voix    : un modèle ouvert lit ce texte (même service local).
 * Aucun modèle ne formule donc un fait ni un chiffre. Ce que la chaîne ne sait pas faire : comprendre une phrase libre,
 * préparer une observation, confirmer un brouillon. Une question non reconnue est dite non reconnue.
 *
 * Les phrases baoulé sont un premier jet tant que `BAOULE_PHRASES.validated` est faux : la réponse le signale toujours.
 */
export interface BaouleOptions {
  /** Adresse du service local de parole (http://127.0.0.1:8765). */
  url: string;
  /** Fichier où sont gardées les formulations enregistrées par un locuteur ; null = en mémoire seulement. */
  examplesFile?: string | null;
  fetchImpl?: typeof fetch;
  listenTimeoutMs?: number;
  speakTimeoutMs?: number;
}

interface BaouleCtx {
  app: FastifyInstance;
  currentUser: (req: FastifyRequest) => Promise<User>;
}

const INTENTS: BaouleIntent[] = ['situation', 'changes', 'missing', 'beacons'];
/** Question française équivalente : c'est elle qui est lue par les règles fixes de l'assistant, comme si elle avait été tapée. */
const FRENCH_QUESTION: Record<BaouleIntent, string> = {
  situation: 'Quelle est la situation de mon élevage ?',
  changes: 'Qu’est-ce qui a changé depuis hier ?',
  missing: 'Quelles informations manquent ?',
  beacons: 'Quel animal s’est éloigné ?',
};
/** En dessous de ce score, ou si deux questions se valent, la question est dite non reconnue plutôt que devinée. */
const MIN_SCORE = 0.5;
const MIN_MARGIN = 0.05;
const MAX_EXAMPLES = 8;

/** Forme de comparaison : minuscules, sans ponctuation ni marques de ton, ɛ et ɔ ramenés à e et o (le modèle d'écoute hésite entre eux). */
export function bciNorm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ɛ/g, 'e')
    .replace(/ɔ/g, 'o')
    .replace(/ɲ/g, 'ny')
    .replace(/ŋ/g, 'n')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
  return m;
}

/** Ressemblance de deux phrases (coefficient de Dice sur les paires de lettres), de 0 à 1. */
export function similarity(a: string, b: string): number {
  const x = bigrams(bciNorm(a));
  const y = bigrams(bciNorm(b));
  let common = 0;
  let total = 0;
  for (const [k, n] of x) {
    common += Math.min(n, y.get(k) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  return total ? (2 * common) / total : 0;
}

/** Question la plus proche de ce qui a été entendu ; « unknown » si rien n'est assez proche ou si deux questions se valent. */
export function matchIntent(heard: string, forms: Record<BaouleIntent, readonly string[]>): { intent: BaouleIntent | 'unknown'; score: number } {
  if (bciNorm(heard).length < 3) return { intent: 'unknown', score: 0 };
  const scored = INTENTS.map((intent) => ({ intent, score: Math.max(0, ...forms[intent].map((f) => similarity(heard, f))) })).sort((a, b) => b.score - a.score);
  const [best, second] = scored as [(typeof scored)[number], (typeof scored)[number]];
  if (best.score < MIN_SCORE || best.score - second.score < MIN_MARGIN) return { intent: 'unknown', score: best.score };
  return best;
}

const data = <T>(reply: AssistantReply, tool: string): T | null => (reply.results.find((r) => r.tool === tool) as ToolResult<T> | undefined)?.data ?? null;

/** Phrase de réponse : gabarits fixes et nombres par règle. `fr` dit en français ce que la voix dit en baoulé. */
export function composeAnswer(intent: BaouleIntent | 'unknown', reply: AssistantReply | null): { bci: string; fr: string } {
  const parts: { bci: string; fr: string }[] = [];
  const say = (key: BaouleAnswerKey, n?: number) => {
    const a = BAOULE_PHRASES.answers[key];
    if (n === undefined) return parts.push({ bci: a.bci, fr: a.fr });
    const words = bciNumber(n);
    // Nombre hors des bornes de la règle : il n'est pas dit du tout, plutôt que dit de travers. L'écran, lui, l'affiche.
    if (words) parts.push({ bci: a.bci.replace('{N}', words), fr: a.fr.replace('{N}', String(n)) });
  };
  const count = (key: BaouleAnswerKey, none: BaouleAnswerKey, n: number) => (n > 0 ? say(key, n) : say(none));
  if (intent === 'unknown' || !reply) {
    say('unknown');
    return parts[0]!;
  }
  if (intent === 'situation') {
    const s = data<SituationData>(reply, 'situation');
    if (s) {
      if (s.animals.total > 0) say('animals', s.animals.total);
      count('changes', 'changesNone', s.recent.counts.total);
      count('missing', 'missingNone', s.toComplete.total);
    }
  } else if (intent === 'changes') {
    const c = data<ChangesData>(reply, 'changes');
    if (c) count('changes', 'changesNone', c.counts.total);
  } else if (intent === 'missing') {
    const m = data<MissingData>(reply, 'missing');
    if (m) count('missing', 'missingNone', m.items.length);
  } else {
    const b = data<BeaconsData>(reply, 'beacons');
    if (b) {
      const out = b.beacons.find((x) => x.status === 'OUTSIDE' && x.latest?.distanceM != null);
      const active = b.beacons.filter((x) => x.status !== 'STOPPED');
      if (out) say('beaconOut', Math.round(out.latest!.distanceM!));
      else if (active.length) say('beaconOk');
      else say('beaconNone');
    }
  }
  if (!parts.length) say('unknown');
  else say('screen');
  return { bci: parts.map((p) => p.bci).join(' '), fr: parts.map((p) => p.fr).join(' ') };
}

export function registerBaoule(ctx: BaouleCtx, tools: FarmTools, opts: BaouleOptions | null) {
  const f = opts?.fetchImpl ?? fetch;
  const examples: Record<BaouleIntent, string[]> = { situation: [], changes: [], missing: [], beacons: [] };
  if (opts?.examplesFile && existsSync(opts.examplesFile)) {
    try {
      const saved = JSON.parse(readFileSync(opts.examplesFile, 'utf8')) as Partial<Record<BaouleIntent, unknown>>;
      for (const i of INTENTS) if (Array.isArray(saved[i])) examples[i] = (saved[i] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_EXAMPLES);
    } catch {
      /* fichier illisible : on repart des seules phrases du dépôt */
    }
  }
  const forms = (): Record<BaouleIntent, string[]> => ({
    situation: [...BAOULE_PHRASES.questions.situation, ...examples.situation],
    changes: [...BAOULE_PHRASES.questions.changes, ...examples.changes],
    missing: [...BAOULE_PHRASES.questions.missing, ...examples.missing],
    beacons: [...BAOULE_PHRASES.questions.beacons, ...examples.beacons],
  });

  // État du service local, relu de temps en temps : l'écran ne propose le baoulé que si l'écoute ET la voix répondent.
  let health: { stt: boolean; tts: boolean; checkedAt: number; reason: string | null } = { stt: false, tts: false, checkedAt: 0, reason: opts ? 'Service local de parole en baoulé pas encore joint.' : 'Voix en baoulé non activée sur ce serveur.' };
  async function check() {
    if (!opts) return;
    try {
      const r = await f(`${opts.url}/health`, { signal: AbortSignal.timeout(3000) });
      const j = (await r.json()) as { stt?: boolean; tts?: boolean };
      health = { stt: !!j.stt, tts: !!j.tts, checkedAt: Date.now(), reason: j.stt && j.tts ? null : `Service local de parole en baoulé incomplet (écoute : ${j.stt ? 'prête' : 'absente'}, voix : ${j.tts ? 'prête' : 'absente'}).` };
    } catch {
      health = { stt: false, tts: false, checkedAt: Date.now(), reason: 'Service local de parole en baoulé injoignable (tools/baoule/serveur.py n’est pas lancé).' };
    }
  }
  if (opts) {
    void check();
    const timer = setInterval(() => void check(), 15_000);
    timer.unref();
    ctx.app.addHook('onClose', async () => clearInterval(timer));
  }
  const status = (): BaouleStatus => ({
    enabled: !!opts,
    available: !!opts && health.stt && health.tts,
    reason: opts && health.stt && health.tts ? null : health.reason,
    validated: BAOULE_PHRASES.validated,
    examples: INTENTS.reduce((n, i) => n + examples[i].length, 0),
  });

  async function listen(audioBase64: string): Promise<{ text: string; ms: number }> {
    const t = Date.now();
    let r: Response;
    try {
      r = await f(`${opts!.url}/stt`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.from(audioBase64, 'base64'), signal: AbortSignal.timeout(opts!.listenTimeoutMs ?? 90_000) });
    } catch {
      throw new HttpError(503, 'BAOULE_UNAVAILABLE', 'Le service local d’écoute en baoulé ne répond pas. Utilisez le français.');
    }
    const j = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!r.ok || typeof j.text !== 'string') throw new HttpError(502, 'BAOULE_FAILED', 'L’enregistrement n’a pas pu être transcrit. Réessayez, ou utilisez le français.');
    return { text: j.text.trim().slice(0, 400), ms: Date.now() - t };
  }

  async function speak(text: string): Promise<{ audio: string | null; ms: number }> {
    const t = Date.now();
    try {
      const r = await f(`${opts!.url}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(opts!.speakTimeoutMs ?? 90_000) });
      if (!r.ok) return { audio: null, ms: Date.now() - t };
      return { audio: Buffer.from(await r.arrayBuffer()).toString('base64'), ms: Date.now() - t };
    } catch {
      // La voix a échoué : la réponse écrite (en français) reste entière, et l'écran dit que rien n'a été dit.
      return { audio: null, ms: Date.now() - t };
    }
  }

  const audioOf = (body: unknown): string => {
    const b = body as { audio?: unknown; mimeType?: unknown } | null;
    if (!b || typeof b.audio !== 'string' || b.audio.length < 400 || b.audio.length > 3_500_000 || b.mimeType !== 'audio/wav') throw new HttpError(400, 'VALIDATION', 'Enregistrement absent, trop long ou dans un format inattendu.');
    return b.audio;
  };
  const ready = () => {
    if (!opts) throw new HttpError(503, 'BAOULE_DISABLED', 'La voix en baoulé n’est pas activée sur ce serveur.');
  };

  /** Une note vocale en baoulé : transcription locale, question rapprochée, lecture des données, réponse dite en baoulé. Rien n'est conservé. */
  ctx.app.post('/api/assistant/baoule', { bodyLimit: 4 * 1024 * 1024 }, async (req): Promise<BaouleReply> => {
    const u = await ctx.currentUser(req);
    ready();
    const heard = await listen(audioOf(req.body));
    const m = matchIntent(heard.text, forms());
    const base: AssistantReply =
      m.intent === 'unknown'
        ? { mode: 'direct', provider: null, intent: 'unknown', text: null, notice: 'Question en baoulé non reconnue : aucune donnée n’a été lue. Aucune réponse n’est devinée.', results: [], ungrounded: false, suggestions: [] }
        : await answerDirect(tools, u, { text: FRENCH_QUESTION[m.intent] } as AskInput);
    const reply: AssistantReply = m.intent === 'unknown' ? base : { ...base, notice: `Question dite en baoulé, rapprochée de « ${FRENCH_QUESTION[m.intent]} » par une règle de ressemblance. Lecture directe des données, sans IA générative.` };
    const answer = composeAnswer(m.intent, reply);
    const voice = await speak(answer.bci);
    return { heard: heard.text, intent: m.intent, score: Math.round(m.score * 100) / 100, question: m.intent === 'unknown' ? null : FRENCH_QUESTION[m.intent], reply, spoken: answer.bci, spokenFr: answer.fr, audio: voice.audio, validated: BAOULE_PHRASES.validated, listenMs: heard.ms, speakMs: voice.ms };
  });

  /**
   * Un locuteur enregistre SA façon de poser l'une des questions : seule la transcription est gardée, comme point de comparaison.
   * C'est ce qui rend la reconnaissance fiable sans que personne n'ait à écrire du baoulé.
   */
  ctx.app.post('/api/assistant/baoule/exemple', { bodyLimit: 4 * 1024 * 1024 }, async (req): Promise<{ intent: BaouleIntent; heard: string; examples: number }> => {
    await ctx.currentUser(req);
    ready();
    const intent = (req.body as { intent?: unknown } | null)?.intent;
    if (typeof intent !== 'string' || !INTENTS.includes(intent as BaouleIntent)) throw new HttpError(400, 'VALIDATION', 'Question inconnue.');
    const heard = await listen(audioOf(req.body));
    if (bciNorm(heard.text).length < 3) throw new HttpError(422, 'BAOULE_EMPTY', 'Rien d’audible n’a été transcrit. Réessayez plus près du micro.');
    const list = examples[intent as BaouleIntent];
    list.push(heard.text);
    while (list.length > MAX_EXAMPLES) list.shift();
    if (opts?.examplesFile) {
      try {
        mkdirSync(dirname(opts.examplesFile), { recursive: true });
        writeFileSync(opts.examplesFile, JSON.stringify(examples, null, 2), 'utf8');
      } catch {
        /* gardé en mémoire seulement */
      }
    }
    return { intent: intent as BaouleIntent, heard: heard.text, examples: list.length };
  });

  return { status, check };
}
