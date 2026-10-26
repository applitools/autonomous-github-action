// Minimal client for the Applitools Autonomous REST API.
// Docs: https://applitools.com/docs/autonomous/content/topics/api-execute.htm
//       https://applitools.com/docs/autonomous/content/topics/api-get-results.htm

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 120_000;

export class ApiError extends Error {
  constructor(message, { status, retryable = false, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

export class AutonomousClient {
  constructor({
    apiKey,
    serverUrl = 'https://autonomous.applitools.com',
    maxRetries = 5,
    requestTimeoutMs = 30_000,
    retryBaseMs = 1_000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
  }) {
    if (!apiKey) throw new Error('api-key is required');
    this.apiKey = apiKey;
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.maxRetries = maxRetries;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retryBaseMs = retryBaseMs;
    this.sleep = sleep;
    this.log = log;
  }

  executePlan(planId, parameterValues) {
    const body = parameterValues ? { parameter_values: parameterValues } : undefined;
    return this.#execute('plan', planId, body);
  }

  executeTest(testId, parameterValues) {
    const body = parameterValues ? { parameter_values: parameterValues } : undefined;
    return this.#execute('test', testId, body);
  }

  async getResult(runId, readToken) {
    const query = readToken ? { read_token: readToken } : {};
    const data = await this.#request('GET', `/api/result/${encodeURIComponent(runId)}`, { query });
    if (!data?.result) throw new ApiError(`Unexpected result response for run ${runId}`, { body: data });
    return data.result;
  }

  async #execute(kind, id, body) {
    const data = await this.#request('POST', `/api/${kind}/${encodeURIComponent(id)}/execute`, { body });
    const result = data?.result;
    if (!result?.id) throw new ApiError(`Unexpected execute response for ${kind} ${id}`, { body: data });
    return { id: result.id, readToken: result.read_token };
  }

  // Retries network errors, timeouts, 429 and 5xx with exponential backoff.
  // Execute calls are retried too: a rare duplicate run is better than a gate
  // that fails because of a transient blip.
  async #request(method, path, { query = {}, body } = {}) {
    const url = new URL(this.serverUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set('apiKey', this.apiKey);

    for (let attempt = 0; ; attempt++) {
      let error;
      let retryAfterMs;
      try {
        const res = await fetch(url, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        const text = this.redact(await res.text());
        if (res.ok) {
          try {
            return text ? JSON.parse(text) : {};
          } catch {
            throw new ApiError(`${method} ${path} returned invalid JSON: ${text.slice(0, 200)}`, { status: res.status });
          }
        }
        error = new ApiError(describeHttpError(method, path, res.status, text), {
          status: res.status,
          retryable: RETRYABLE_STATUSES.has(res.status),
          body: text,
        });
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      } catch (err) {
        if (err instanceof ApiError) throw err;
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        const reason = timedOut
          ? `timed out after ${this.requestTimeoutMs / 1000}s`
          : this.redact(err?.cause?.message || err?.message || String(err));
        error = new ApiError(`${method} ${path} failed: ${reason}`, { retryable: true });
      }

      if (!error.retryable || attempt >= this.maxRetries) throw error;
      const backoff = Math.min(MAX_BACKOFF_MS, this.retryBaseMs * 2 ** attempt);
      const delay = retryAfterMs ?? Math.round(backoff / 2 + Math.random() * (backoff / 2));
      this.log(`${error.message}; retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${this.maxRetries})`);
      await this.sleep(delay);
    }
  }

  // The API echoes the request URL (including apiKey) in some error bodies.
  redact(text) {
    return String(text).split(this.apiKey).join('***');
  }
}

function describeHttpError(method, path, status, text) {
  const detail = extractMessage(text);
  const hint = {
    400: 'check that the plan/test ID is correct and the request parameters are valid',
    401: 'the API key is invalid or revoked',
    403: 'the API key lacks permission (execute to start runs; read, or the run read token, to get results)',
    404: 'not found',
    429: 'rate limited',
  }[status] ?? (status >= 500 ? 'Autonomous server error' : undefined);
  return [`${method} ${path} -> HTTP ${status}`, hint, detail].filter(Boolean).join(': ');
}

function extractMessage(text) {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    return parsed?.message ?? '';
  } catch {
    return text.slice(0, 200);
  }
}

function parseRetryAfter(value) {
  if (value == null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
  return undefined;
}
