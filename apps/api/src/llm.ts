/**
 * Clients LLM interchangeables, appelés UNIQUEMENT côté serveur.
 * - anthropic : API Messages d'Anthropic (clé requise, facturée par le fournisseur).
 * - openai-compatible : tout service exposant /chat/completions (OpenAI, Mistral, ou un modèle local
 *   gratuit via Ollama « http://localhost:11434/v1 » ou LM Studio « http://localhost:1234/v1 »).
 * L'adresse du service est une configuration serveur, jamais une donnée fournie par l'utilisateur.
 */
export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
}
export interface LlmClient {
  readonly name: string;
  complete(req: LlmRequest, signal: AbortSignal): Promise<string>;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export function anthropicClient(opts: { apiKey: string; model: string; baseUrl?: string }): LlmClient {
  const base = trimSlash(opts.baseUrl || 'https://api.anthropic.com');
  return {
    name: `Anthropic (${opts.model})`,
    async complete(req, signal) {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: opts.model, max_tokens: req.maxTokens, temperature: 0, system: req.system, messages: [{ role: 'user', content: req.user }] }),
      });
      if (!res.ok) throw new Error(`Fournisseur IA : HTTP ${res.status}`);
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      return body.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? '';
    },
  };
}

export function openAiCompatibleClient(opts: { baseUrl: string; model: string; apiKey?: string }): LlmClient {
  const base = trimSlash(opts.baseUrl);
  return {
    name: `${opts.model} (${new URL(base).host})`,
    async complete(req, signal) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: req.maxTokens,
          temperature: 0,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Fournisseur IA : HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return body.choices?.[0]?.message?.content ?? '';
    },
  };
}

/** Extrait le premier objet JSON d'une réponse textuelle (le modèle peut ajouter du texte autour). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Réponse sans objet JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/** Construit le client à partir de la configuration serveur ; null = IA désactivée. */
export function llmFromConfig(c: { provider: string; apiKey: string; baseUrl: string; model: string }): LlmClient | null {
  if (c.provider === 'anthropic' && c.apiKey) return anthropicClient({ apiKey: c.apiKey, model: c.model || 'claude-haiku-5-5', baseUrl: c.baseUrl || undefined });
  if (c.provider === 'openai-compatible' && c.baseUrl && c.model) return openAiCompatibleClient({ baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey || undefined });
  return null;
}
