// A fake Autonomous API with scripted responses per plan/test ID.
//
// scenarios: { [planOrTestId]: { execute?: Response[], poll?: Response[] } }
// Response: { status = 200, body, raw, headers, delayMs }  (raw is sent as-is)
// Each list is consumed in order; the last entry repeats. If `execute` is
// omitted a run is created normally; `poll` is served for that run's results.

import http from 'node:http';

export const API_KEY = 'test-key-123';

// Matches the live API: status "pending" and empty counts until the run finishes.
export function running(results = {}) {
  return { body: { result: { status: 'pending', results, tests: [] } } };
}

export function finished(status, results = {}) {
  return { body: { result: { status, results: { passed: 0, failed: 0, unresolved: 0, aborted: 0, pending: 0, ...results }, tests: [] } } };
}

export async function startMockServer(scenarios = {}) {
  const requests = [];
  const runs = new Map(); // runId -> { scenario, polls }
  const executeCalls = new Map(); // targetId -> count
  let runCounter = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

    if (url.searchParams.get('apiKey') !== API_KEY) {
      res.writeHead(401).end('Unauthorized');
      return;
    }

    let match = url.pathname.match(/^\/api\/(plan|test)\/([^/]+)\/execute$/);
    if (req.method === 'POST' && match) {
      const id = decodeURIComponent(match[2]);
      const scenario = scenarios[id];
      if (!scenario) return send(res, { status: 400, body: {} });
      const n = executeCalls.get(id) ?? 0;
      executeCalls.set(id, n + 1);
      if (scenario.execute) {
        const scripted = pick(scenario.execute, n);
        if ((scripted.status ?? 200) !== 200 || scripted.body || scripted.raw) return send(res, scripted);
      }
      const runId = `run-${id}-${++runCounter}`;
      runs.set(runId, { scenario, polls: 0 });
      return send(res, { body: { result: { id: runId, read_token: `token-${runId}` } } });
    }

    match = url.pathname.match(/^\/api\/result\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const run = runs.get(decodeURIComponent(match[1]));
      if (!run) return send(res, { status: 404, body: { message: `plan execution ${match[1]} not found`, statusCode: 404 } });
      const response = pick(run.scenario.poll ?? [finished('passed', { passed: 1 })], run.polls++);
      if (response.body?.result) {
        response.body.result.id = match[1];
        response.body.result.planResultsUrl ??= `https://autonomous.example/results/${match[1]}/tests`;
      }
      return send(res, response);
    }

    // Mirrors the real API, which echoes the full URL (including apiKey).
    send(res, { status: 404, body: { message: `Route ${req.method}:${req.url} not found`, error: 'Not Found', statusCode: 404 } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

function pick(list, i) {
  return structuredClone(list[Math.min(i, list.length - 1)]);
}

async function send(res, { status = 200, body, raw, headers = {}, delayMs = 0 }) {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(raw ?? (body === undefined ? '' : JSON.stringify(body)));
}
