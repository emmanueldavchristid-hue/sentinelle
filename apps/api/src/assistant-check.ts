import { checkAssistantConfig, config, envFile, envFileLoaded } from './config.js';
import { GeminiError, geminiModel, listGeminiModels } from './gemini.js';

/**
 * Vérification réelle de la connexion à Gemini : « pnpm assistant:check ».
 * 1. liste les modèles disponibles avec la clé ; 2. appel minimal ; 3. appel de fonction.
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

  const model = geminiModel({ apiKey: config.geminiApiKey, model: config.geminiModel });
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
  say(`\nRésultat : texte ${called ? 'et appels de fonctions opérationnels' : 'opérationnel, appels de fonctions NON confirmés'}. Voix (API Live) : non testée par cette commande.`);
  process.exit(called ? 0 : 1);
} finally {
  clearTimeout(timer);
}
