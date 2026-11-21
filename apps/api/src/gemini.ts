/**
 * Client Gemini (API Google AI Studio), appelé UNIQUEMENT côté serveur, par requêtes REST `generateContent`.
 * Points relus dans la documentation Google le 21/11/2026 (à revérifier avec une vraie clé via « pnpm assistant:check ») :
 * - POST {base}/v1beta/models/{modèle}:generateContent ; liste des modèles : GET {base}/v1beta/models ;
 * - `tools[].functionDeclarations`, `toolConfig.functionCallingConfig.mode`, `systemInstruction`, `generationConfig` ;
 * - les parties `functionCall` du modèle peuvent porter une `thoughtSignature` : le contenu du modèle est donc renvoyé
 *   TEL QUEL au tour suivant, sans le reconstruire.
 * La clé voyage dans l'en-tête `x-goog-api-key`, jamais dans une URL, un journal ou un message d'erreur.
 */
export interface GeminiTool {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}
export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}
export interface ToolLoopInput {
  system: string;
  history: ChatTurn[];
  user: string;
  tools: GeminiTool[];
  /** Exécute une fonction validée côté serveur et renvoie son résultat (ou une erreur lisible). */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  maxRounds: number;
  signal: AbortSignal;
}
export interface ToolLoopOutput {
  text: string;
  calls: { name: string; args: Record<string, unknown> }[];
}
export interface AssistantModel {
  readonly provider: string;
  readonly model: string;
  runWithTools(input: ToolLoopInput): Promise<ToolLoopOutput>;
}

export class GeminiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  [k: string]: unknown;
}
interface Content {
  role?: string;
  parts?: Part[];
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

/** Message lisible pour chaque famille d'erreur, sans jamais reprendre le corps brut ni la clé. */
function describeError(status: number, apiStatus: string | undefined): GeminiError {
  if (status === 400) return new GeminiError(status, apiStatus ?? 'INVALID_ARGUMENT', 'Gemini a refusé la requête (400). Vérifiez GEMINI_MODEL et relancez « pnpm assistant:check ».');
  if (status === 401 || status === 403) return new GeminiError(status, apiStatus ?? 'PERMISSION_DENIED', `Gemini a refusé la clé (${status}) : clé invalide, restreinte, ou API non autorisée pour ce projet Google.`);
  if (status === 404) return new GeminiError(status, apiStatus ?? 'NOT_FOUND', 'Modèle Gemini introuvable (404) : GEMINI_MODEL ne correspond à aucun modèle disponible avec cette clé.');
  if (status === 429) return new GeminiError(status, apiStatus ?? 'RESOURCE_EXHAUSTED', 'Quota Gemini atteint (429) : réessayez plus tard, ou vérifiez les limites du projet Google.');
  if (status >= 500) return new GeminiError(status, apiStatus ?? 'UNAVAILABLE', `Service Gemini indisponible (${status}).`);
  return new GeminiError(status, apiStatus ?? 'ERROR', `Erreur Gemini (${status}).`);
}

async function request<T>(url: string, apiKey: string, init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      signal: init.signal,
      headers: { 'x-goog-api-key': apiKey, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    if (init.signal?.aborted) throw new GeminiError(0, 'TIMEOUT', 'Gemini n’a pas répondu à temps.');
    throw new GeminiError(0, 'NETWORK', `Service Gemini injoignable (${e instanceof Error && e.name !== 'TypeError' ? e.name : 'réseau'}).`);
  }
  if (!res.ok) {
    let apiStatus: string | undefined;
    try {
      apiStatus = ((await res.json()) as { error?: { status?: string } }).error?.status;
    } catch {
      /* corps illisible : le code HTTP suffit */
    }
    throw describeError(res.status, apiStatus);
  }
  return (await res.json()) as T;
}

/** Modèles réellement disponibles avec cette clé (noms sans le préfixe « models/ »). */
export async function listGeminiModels(opts: { apiKey: string; baseUrl?: string; signal?: AbortSignal }): Promise<{ name: string; displayName: string; methods: string[] }[]> {
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const out: { name: string; displayName: string; methods: string[] }[] = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const r = await request<{ models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string }>(
      `${base}/v1beta/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      opts.apiKey,
      { method: 'GET', signal: opts.signal },
    );
    for (const m of r.models ?? []) out.push({ name: m.name.replace(/^models\//, ''), displayName: m.displayName ?? '', methods: m.supportedGenerationMethods ?? [] });
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return out;
}

export function geminiModel(opts: { apiKey: string; model: string; baseUrl?: string }): AssistantModel {
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
  return {
    provider: 'Gemini',
    model: opts.model,
    async runWithTools(input) {
      const contents: Content[] = [...input.history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })), { role: 'user', parts: [{ text: input.user }] }];
      const calls: ToolLoopOutput['calls'] = [];
      for (let round = 0; round <= input.maxRounds; round++) {
        const lastRound = round === input.maxRounds;
        const res = await request<{ candidates?: { content?: Content; finishReason?: string }[]; promptFeedback?: { blockReason?: string } }>(url, opts.apiKey, {
          method: 'POST',
          signal: input.signal,
          body: {
            systemInstruction: { parts: [{ text: input.system }] },
            contents,
            tools: [{ functionDeclarations: input.tools }],
            // Dernier tour : plus aucun appel d'outil, le modèle doit conclure avec ce qu'il a obtenu.
            toolConfig: { functionCallingConfig: { mode: lastRound ? 'NONE' : 'AUTO' } },
            generationConfig: { maxOutputTokens: 1200 },
          },
        });
        if (res.promptFeedback?.blockReason) throw new GeminiError(200, 'BLOCKED', 'Gemini a bloqué cette demande.');
        const content = res.candidates?.[0]?.content;
        const parts = content?.parts ?? [];
        const fnCalls = parts.filter((p) => p.functionCall);
        if (!fnCalls.length || lastRound) {
          const text = parts
            .filter((p) => typeof p.text === 'string' && !p.thought)
            .map((p) => p.text)
            .join('')
            .trim();
          if (!text) throw new GeminiError(200, 'EMPTY', 'Gemini a renvoyé une réponse vide.');
          return { text, calls };
        }
        // Le contenu du modèle est renvoyé tel quel (signatures de raisonnement comprises), suivi des résultats des fonctions.
        contents.push({ role: 'model', parts });
        const responses: Part[] = [];
        for (const p of fnCalls) {
          const fc = p.functionCall!;
          const args = fc.args ?? {};
          calls.push({ name: fc.name, args });
          let result: unknown;
          try {
            result = await input.callTool(fc.name, args);
          } catch (e) {
            result = { error: e instanceof Error ? e.message : 'Erreur de la fonction' };
          }
          responses.push({ functionResponse: { name: fc.name, response: { result }, ...(fc.id ? { id: fc.id } : {}) } });
        }
        contents.push({ role: 'user', parts: responses });
      }
      throw new GeminiError(200, 'LOOP', 'Gemini n’a pas conclu.');
    },
  };
}
