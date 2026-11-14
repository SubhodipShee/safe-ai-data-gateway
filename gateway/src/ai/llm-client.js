// =============================================================================
// ai/llm-client.js: talks to the AI provider (Groq, Gemini, Ollama…)
// =============================================================================
//
// Almost every AI provider now accepts the same request format as OpenAI's
// "chat completions" API. So ONE small client works with all of them; only the
// address (base URL), the API key and the model name change:
//
//   Provider   Base URL                                                  Free?
//   ────────   ───────────────────────────────────────────────────────   ─────────────────
//   groq       https://api.groq.com/openai/v1                            yes, no card
//   gemini     https://generativelanguage.googleapis.com/v1beta/openai   free tier (small)
//   ollama     http://localhost:11434/v1                                 yes (your own PC)
//
// Switching provider = change AI_PROVIDER in .env. No code changes.
//
// IMPORTANT: this client only ever receives text that the masker has ALREADY
// cleaned. It never sees real personal data.
// =============================================================================

// Default models were checked against each provider's live model list (Nov 2026).
// Providers retire models regularly. If one disappears, `npm run check-ai` lists
// the current ones, and AI_MODEL in .env overrides the default.
//   Groq test (Nov 2026): gpt-oss-120b kept 3/3 tags in 0.8 s; qwen3.8-27b dropped one.
export const PROVIDERS = {
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'openai/gpt-oss-120b' },
  gemini: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash' },
  ollama: { name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.2' },
};

const REQUEST_TIMEOUT_MS = 60_000;

/** An error from the AI provider, with an HTTP status the gateway can pass on. */
export class AiProviderError extends Error {
  constructor(message, status, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Creates the client.
 * @param {object} options
 * @param {string} options.provider  'groq' | 'gemini' | 'ollama' | 'custom'
 * @param {string} [options.apiKey]
 * @param {string} [options.model]    defaults to the provider's default model
 * @param {string} [options.baseUrl]  only needed for 'custom' (or to override)
 */
export function createLlmClient({ provider, apiKey, model, baseUrl }) {
  const known = PROVIDERS[provider];
  const settings = {
    providerName: known?.name ?? provider,
    baseUrl: (baseUrl || known?.baseUrl || '').replace(/\/+$/, ''),
    model: model || known?.defaultModel,
  };
  // Ollama runs on your own computer and needs no key; everything else does.
  const configured = Boolean(settings.baseUrl && settings.model && (apiKey || provider === 'ollama'));

  /**
   * Sends a conversation to the AI and returns its reply.
   * @param {{ role: string, content: string }[]} messages  ALREADY MASKED messages
   * @param {object} [options]
   * @param {number} [options.temperature]
   * @param {number} [options.maxTokens]
   * @returns {Promise<{ content: string, model: string, usage: object, finishReason: string }>}
   */
  async function chat(messages, { temperature, maxTokens } = {}) {
    if (!configured) {
      throw new AiProviderError('No AI provider is configured. Set AI_PROVIDER and AI_API_KEY in gateway/.env.', 503);
    }

    let response;
    try {
      response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        }),
        // Give up after 60 seconds instead of hanging forever.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError';
      throw new AiProviderError(
        timedOut ? `${settings.providerName} did not answer within 60 seconds.` : `Could not reach ${settings.providerName}.`,
        timedOut ? 504 : 502,
      );
    }

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      // Turn the provider's error into a clear message. (The API key is never included.)
      const providerMessage = String(body?.error?.message || body?.message || '').slice(0, 200);
      if (response.status === 401 || response.status === 403) {
        throw new AiProviderError(`${settings.providerName} rejected the API key. Check AI_API_KEY in gateway/.env.`, 502);
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) || undefined;
        throw new AiProviderError(`${settings.providerName} free-tier limit reached. Try again shortly.`, 429, retryAfter);
      }
      if (response.status === 404) {
        throw new AiProviderError(`${settings.providerName} doesn't know the model "${settings.model}". Run: npm run check-ai`, 502);
      }
      throw new AiProviderError(`${settings.providerName} error ${response.status}: ${providerMessage}`, 502);
    }

    const choice = body.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason,
      model: body.model || settings.model,
      usage: body.usage,
    };
  }

  /** Lists the models this API key can use (for `npm run check-ai`). */
  async function listModels() {
    const response = await fetch(`${settings.baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new AiProviderError(`Listing models failed: HTTP ${response.status}`, 502);
    const body = await response.json();
    return (body.data ?? []).map((m) => m.id).sort();
  }

  return {
    chat,
    listModels,
    configured,
    providerName: settings.providerName,
    model: settings.model,
  };
}
