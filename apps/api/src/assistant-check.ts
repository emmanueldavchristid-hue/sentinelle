import { checkAssistantConfig, config, envFile, envFileLoaded } from './config.js';
import { WebSocket } from 'ws';
import { GeminiError, geminiModel, listGeminiModels } from './gemini.js';

/**
 * Vérification réelle de la connexion à Gemini : « pnpm assistant:check ».
 * 1. liste les modèles disponibles avec la clé ; 2. appel minimal ; 3. appel de fonction ; 4. synthèse vocale ;
 * 5. ouverture d'une conversation en direct (API Live).
 * N'affiche jamais la clé. Chaque étape effectue de vrais appels (consommation minime sur le quota du projet Google).
 */
const say = (s: string) => console.log(s);
say(`Fichier de configuration : ${envFileLoaded ? `${envFile} (chargé)` : `${envFile} (absent)`}`);
if (!config.geminiApiKey) {
  for (const m of checkAssistantConfig().messages) say(m);
  process.exit(1);
}
say('Clé GEMINI_API_KEY : présente (valeur non affichée).');
if (config.googleApiKeyAlsoSet) say('Attention : GOOGLE_API_KEY est aussi définie. Ce serveur n’utilise que GEMINI_API_KEY.');

const fail = (step: string, e: unknown): never => {
  say(`ÉCHEC, ${step} : ${e instanceof GeminiError ? `${e.message} [${e.code}]` : 'erreur inattendue'}`);
  process.exit(1);
};

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 60_000);
try {
  say('\n1. Modèles disponibles avec cette clé (génération de texte) :');
  const models = await listGeminiModels({ apiKey: config.geminiApiKey, signal: ac.signal }).catch((e) => fail('liste des modèles', e));
  const usable = models.filter((m) => m.methods.includes('generateContent'));
  for (const m of usable) say(`   ${m.name}${m.displayName ? `  (${m.displayName})` : ''}`);
  say(`   ${usable.length} modèle(s). Vérifiez sur la page des tarifs Google que le modèle retenu est dans le palier gratuit.`);
  if (!config.geminiModel) {
    say('\nGEMINI_MODEL n’est pas renseigné : choisissez un nom dans la liste ci-dessus, écrivez-le dans le fichier .env, puis relancez cette commande.');
    process.exit(1);
  }
  if (!usable.some((m) => m.name === config.geminiModel)) say(`   Attention : GEMINI_MODEL=${config.geminiModel} n’est pas dans cette liste.`);

  const model = geminiModel({ apiKey: config.geminiApiKey, model: config.geminiModel, fallbackModel: config.geminiFallbackModel || undefined, ttsModel: config.geminiTtsModel || undefined, ttsVoice: config.geminiTtsVoice });
  if (config.geminiFallbackModel) say(`\n   Modèle de secours en cas de surcharge (503) : ${config.geminiFallbackModel}`);
  say(`\n2. Appel minimal sur ${config.geminiModel} :`);
  const hello = await model.runWithTools({ system: 'Réponds par le seul mot OK.', history: [], user: 'Test de connexion.', tools: [], callTool: async () => ({}), maxRounds: 0, signal: ac.signal }).catch((e) => fail('appel minimal', e));
  say(`   Réponse reçue (${hello.text.length} caractères) : opérationnel.`);

  say('\n3. Appel de fonction :');
  let called = false;
  const fn = await model
    .runWithTools({
      system: 'Pour toute question sur l’exploitation, appelle la fonction disponible avant de répondre.',
      history: [],
      user: 'Combien d’animaux sont enregistrés ?',
      tools: [{ name: 'get_situation', description: 'Nombre d’animaux enregistrés dans l’exploitation.', parameters: { type: 'object', properties: {} } }],
      callTool: async () => {
        called = true;
        return { statements: [{ nature: 'FACT', text: '8 animaux identifiés sont enregistrés (valeur de test).', sources: [] }] };
      },
      maxRounds: 2,
      signal: ac.signal,
    })
    .catch((e) => fail('appel de fonction', e));
  say(called ? `   Fonction appelée par le modèle, réponse finale reçue (${fn.text.length} caractères) : opérationnel.` : '   Le modèle a répondu SANS appeler la fonction : appels d’outils non confirmés avec ce modèle. Essayez un autre modèle.');
  say('\n4. Réponse parlée (synthèse vocale) :');
  if (!model.speak) say('   GEMINI_TTS_MODEL n’est pas renseigné : les réponses seront lues par la voix de synthèse de l’appareil.');
  else {
    // Cette étape consomme une demande de synthèse vocale. Sur le palier gratuit, le modèle vocal constaté le 22/11/2026
    // n'en accepte que 10 par jour : un échec ici n'empêche pas le reste (la voix de l'appareil prend le relais).
    const t0 = Date.now();
    try {
      const audio = await model.speak({ text: 'Cinq enregistrements ont été reçus depuis hier.', signal: ac.signal });
      say(`   Son reçu (${Math.round(audio.length / 1024)} Ko en ${Date.now() - t0} ms, modèle ${config.geminiTtsModel}) : opérationnel. Le contenu n’est pas écouté par cette commande.`);
    } catch (e) {
      say(`   INDISPONIBLE pour l’instant : ${e instanceof GeminiError ? `${e.message} [${e.code}]` : 'erreur inattendue'}`);
      say('   Les réponses par tours seront dites par la voix de synthèse de l’appareil. La conversation en direct n’utilise pas ce modèle.');
    }
  }

  say('\n5. Conversation en direct (API Live) :');
  let live: 'ok' | 'absent' | 'échec' = 'absent';
  if (!config.geminiLiveModel) say('   GEMINI_LIVE_MODEL n’est pas renseigné : conversation en direct indisponible, la dictée et le texte restent.');
  else {
    const t0 = Date.now();
    live = await new Promise<'ok' | 'échec'>((resolve) => {
      // La clé voyage dans un en-tête, jamais dans l'adresse.
      const ws = new WebSocket('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent', { headers: { 'x-goog-api-key': config.geminiApiKey } });
      const done = (r: 'ok' | 'échec', why: string) => {
        clearTimeout(limit);
        say(`   ${why}`);
        try {
          ws.close();
        } catch {
          /* déjà fermée */
        }
        resolve(r);
      };
      const limit = setTimeout(() => done('échec', 'Aucune réponse en 12 secondes.'), 12_000);
      ws.on('open', () => ws.send(JSON.stringify({ setup: { model: `models/${config.geminiLiveModel}`, generationConfig: { responseModalities: ['AUDIO'] } } })));
      ws.on('message', (d) => {
        if (String(d).includes('setupComplete')) done('ok', `Session ouverte en ${Date.now() - t0} ms sur ${config.geminiLiveModel} : opérationnel. Aucun son n’est échangé par cette commande.`);
      });
      ws.on('unexpected-response', (_q, res) => done('échec', `Refus à l’ouverture (HTTP ${res.statusCode}).`));
      ws.on('error', () => done('échec', 'Connexion impossible.'));
      ws.on('close', (code, reason) => done('échec', `Fermée par le service (${code}) : ${String(reason).split(config.geminiApiKey).join('<clé>').slice(0, 160)}`));
    });
  }
  say(`\nRésultat : texte ${called ? 'et appels de fonctions opérationnels' : 'opérationnel, appels de fonctions NON confirmés'}. Conversation en direct : ${live === 'ok' ? 'opérationnelle' : live === 'absent' ? 'non configurée' : 'EN ÉCHEC (la dictée et le texte restent)'}.`);
  process.exit(called ? 0 : 1);
} finally {
  clearTimeout(timer);
}
