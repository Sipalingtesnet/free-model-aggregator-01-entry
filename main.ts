import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  authHeaders,
  buildCatalog,
  capabilitiesOf,
  isRecord,
  joinBase,
  meetsRequirements,
  modelFree,
  probeProvider,
  ratingOfModel,
  readBrief,
  type CatalogReport,
  type Json,
  type Probe,
  type ProbedModel,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIModelList,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: CatalogReport = { providers: [] };
let manifestIndex = 0;

/** Per-provider call counts over the trial. */
const providerCallCounts = new Map<string, number>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await Promise.all(brief.directory.providers.map((provider) => probeProvider(ENV_URL, provider, PROBE_TIMEOUT_MS)));
  for (const probe of probes) if (!probe.ok && probe.error !== null) log(probe.error);
  catalog = buildCatalog(ENV_URL, probes, brief.ratings);
}

const byId = (a: ProbedModel, b: ProbedModel): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function servedModels(): ServedModel[] {
  const out: ServedModel[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort(byId)) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  return out;
}

interface Candidate {
  probe: Probe;
  model: ProbedModel;
  rating: number;
}
/**
 * Return a RANKED LIST of candidates (probe+model) that are free and meet the requirements,
 * sorted by rating_milli descending (missing row counts as 0). Skip paid models.
 * For JSON-mode requests (body requires json), exclude anthropic-wire providers.
 */
function rankedCandidatesFor(requires: Requirement): Candidate[] {
  const candidates: Candidate[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    if (requires.json && probe.provider.wire === 'anthropic') {
      continue;
    }
    for (const model of probe.models) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      const caps = capabilitiesOf(model, row);
      if (!meetsRequirements(requires, caps)) continue;
      const rating = row?.rating_milli ?? 0;
      candidates.push({ probe, model, rating });
    }
  }
  // Sort descending by rating_milli, then stable/id secondary sort
  candidates.sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (a.probe.provider.id !== b.probe.provider.id) {
      return a.probe.provider.id < b.probe.provider.id ? -1 : 1;
    }
    return a.model.id < b.model.id ? -1 : 1;
  });
  return candidates;
}

function requirementsFor(body: Json): Requirement {
  const manifest = brief.workload?.manifest ?? [];
  const entry = manifest[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

async function callProvider(probe: Probe, modelId: string, body: Json): Promise<Response> {
  const providerId = probe.provider.id;
  const currentCount = providerCallCounts.get(providerId) ?? 0;
  providerCallCounts.set(providerId, currentCount + 1);

  const base = joinBase(ENV_URL, probe.provider.base);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...authHeaders(probe.provider.auth, probe.provider.key),
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, model: modelId }) });
}

async function pipeStream(stream: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
/**
 * Try candidates with rating routing, per-provider soft budget (<4 calls preferred),
 * and failover (HTTP 402/429/5xx or fetch throw marks provider suspect for this request and tries next).
 */
async function executeWithFailover(
  requires: Requirement,
  body: Json,
  isAnthropicWireClient: boolean
): Promise<{ upstream: Response; candidate: Candidate } | null> {
  const candidates = rankedCandidatesFor(requires);
  if (candidates.length === 0) return null;

  // Sort candidates so that providers with < 4 calls used come first, preserving rating order within groups.
  const sorted = [...candidates].sort((a, b) => {
    const aCalls = providerCallCounts.get(a.probe.provider.id) ?? 0;
    const bCalls = providerCallCounts.get(b.probe.provider.id) ?? 0;
    const aUnder = aCalls < 4 ? 0 : 1;
    const bUnder = bCalls < 4 ? 0 : 1;
    if (aUnder !== bUnder) return aUnder - bUnder;
    return b.rating - a.rating;
  });

  const suspectProviders = new Set<string>();

  for (const candidate of sorted) {
    const pId = candidate.probe.provider.id;
    if (suspectProviders.has(pId)) continue;

    // Skip non-openai-wire providers for now (Step 3: leave TODO comment, gemini/anthropic upstream comes in Step 5/6)
    if (candidate.probe.provider.wire !== 'openai') {
      continue;
    }

    try {
      const upstream = await callProvider(candidate.probe, candidate.model.id, body);
      // HTTP 402, 429, or 5xx are failure/suspect triggers
      if (upstream.status === 402 || upstream.status === 429 || upstream.status >= 500) {
        suspectProviders.add(pId);
        continue;
      }
      return { upstream, candidate };
    } catch {
      suspectProviders.add(pId);
      continue;
    }
  }

  // If all openai-wire candidates failed or were skipped, check if any non-openai candidates exist (for step 3, we return null)
  return null;
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const result = await executeWithFailover(requires, body, false);
  if (result === null) {
    // Check if there are any candidates at all vs no free model
    const candidates = rankedCandidatesFor(requires);
    if (candidates.length === 0) {
      return sendError(res, 'openai', 503, 'no_free_model', 'no free model on the directory meets this request');
    }
    // Found candidates, but none could be successfully called (e.g. non-openai wire or all failed)
    const firstNonOpenai = candidates.find(c => c.probe.provider.wire !== 'openai');
    if (firstNonOpenai) {
      return sendError(res, 'openai', 501, 'not_implemented', `the ${firstNonOpenai.probe.provider.wire} upstream wire is not implemented in this baseline`);
    }
    return sendError(res, 'openai', 503, 'service_unavailable', 'all candidate providers failed or exhausted failover');
  }

  const { upstream, candidate } = result;
  if (body.stream === true && upstream.ok && upstream.body !== null) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await pipeStream(upstream.body, res);
    return;
  }
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  res.end(text);
}
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const candidates = rankedCandidatesFor(requires);
  if (candidates.length === 0) {
    return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model on the directory meets this request');
  }

  // Translate Anthropic body to OpenAI body for calling OpenAI-wire providers
  const firstOpenaiCandidate = candidates.find(c => c.probe.provider.wire === 'openai');
  if (!firstOpenaiCandidate) {
    const firstAny = candidates[0];
    if (firstAny) {
      return sendError(res, 'anthropic', 501, 'api_error', `the ${firstAny.probe.provider.wire} upstream wire is not implemented in this baseline`);
    }
    return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model meets requirements');
  }

  const requested = typeof body.model === 'string' && body.model !== '' ? body.model : firstOpenaiCandidate.model.id;
  const translatedBody = anthropicToOpenAI(body, firstOpenaiCandidate.model.id);

  const result = await executeWithFailover(requires, translatedBody, true);
  if (result === null) {
    return sendError(res, 'anthropic', 503, 'overloaded_error', 'all free model providers failed');
  }

  const { upstream } = result;
  if (!upstream.ok) {
    const text = await upstream.text();
    return sendJson(res, upstream.status, anthropicError('api_error', `the provider answered HTTP ${upstream.status}: ${text.slice(0, 500)}`));
  }
  if (body.stream === true && upstream.body !== null) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for await (const event of anthropicEventsFromOpenAI(upstream.body, requested)) res.write(event);
    res.end();
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, requested));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
}

function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // Retry
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} answered providers and ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
