import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BODY_LIMIT = 256 * 1024;
const RECEIPT_LIMIT = 100;
const MODES = new Set(['success', 'fail', 'flaky', 'timeout', 'commit_then_timeout']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function secureEqual(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let chunks = [];
    let exceeded = false;
    request.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        exceeded = true;
        chunks = [];
        reject(new HttpError(413, 'Body exceeds 256 KiB'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!exceeded) resolveBody(Buffer.concat(chunks));
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new HttpError(400, 'Request aborted')));
  });
}

function parseJson(raw) {
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected object');
    }
    return value;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

function requireJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
}

// A disconnected caller cancels pending work in timeout mode. The
// commit_then_timeout mode intentionally commits before reaching this wait.
function delayResponse(response, delayMs) {
  return new Promise((resolveDelay) => {
    if (response.destroyed) return resolveDelay(false);
    const onClose = () => {
      clearTimeout(timer);
      resolveDelay(false);
    };
    const timer = setTimeout(() => {
      response.off('close', onClose);
      resolveDelay(!response.destroyed);
    }, delayMs);
    response.once('close', onClose);
  });
}

/** An isolated receiver instance. All demonstration state is intentionally in memory. */
export function createReceiver({ apiKey, signingSecret = '', now = Date.now } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('RELAY_API_KEY must be configured');
  }
  if (typeof signingSecret !== 'string') throw new Error('signingSecret must be a string');
  let config = { mode: 'success', failuresRemaining: 0, delayMs: 5000, signingSecret };
  let receivedCount = 0;
  let effectCount = 0;
  let duplicateCount = 0;
  let receipts = [];
  let effects = new Set();
  let resetGeneration = 0;

  function state() {
    return {
      mode: config.mode,
      failuresRemaining: config.failuresRemaining,
      delayMs: config.delayMs,
      signingSecretConfigured: config.signingSecret.length > 0,
      receivedCount,
      effectCount,
      duplicateCount,
      receipts: [...receipts],
    };
  }

  function record(receipt) {
    receipts.push(receipt);
    if (receipts.length > RECEIPT_LIMIT) receipts.shift();
  }

  function applyEffect(eventId) {
    // This synchronous check/add is atomic within Node's single event loop.
    if (effects.has(eventId)) return false;
    effects.add(eventId);
    effectCount += 1;
    return true;
  }

  function updateConfig(input) {
    const allowed = new Set(['mode', 'failuresRemaining', 'delayMs', 'signingSecret']);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'Unknown configuration field');
    }
    if ('mode' in input && !MODES.has(input.mode)) throw new HttpError(400, 'Invalid mode');
    if ('failuresRemaining' in input && (!Number.isInteger(input.failuresRemaining)
      || input.failuresRemaining < 0 || input.failuresRemaining > 10000)) {
      throw new HttpError(400, 'failuresRemaining must be an integer from 0 to 10000');
    }
    if ('delayMs' in input && (!Number.isInteger(input.delayMs)
      || input.delayMs < 0 || input.delayMs > 60000)) {
      throw new HttpError(400, 'delayMs must be an integer from 0 to 60000');
    }
    if ('signingSecret' in input && (typeof input.signingSecret !== 'string'
      || !input.signingSecret.trim() || input.signingSecret.length > 4096)) {
      throw new HttpError(400, 'signingSecret must be a nonblank string of at most 4096 characters');
    }
    config = { ...config, ...input };
  }

  function verifySignature(request, raw) {
    const timestamp = request.headers['x-relay-timestamp'];
    const signature = request.headers['x-relay-signature'];
    if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)
      || typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
    if (Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > 300) return false;
    const expected = 'v1=' + createHmac('sha256', config.signingSecret)
      .update(timestamp + '.')
      .update(raw)
      .digest('hex');
    return secureEqual(signature, expected);
  }

  async function webhook(request, response) {
    receivedCount += 1;
    requireJson(request);
    const raw = await readBody(request);
    if (!config.signingSecret) throw new HttpError(503, 'Receiver signing secret is not configured');
    const signatureValid = verifySignature(request, raw);
    const suppliedId = request.headers['x-relay-event-id'];
    const receipt = {
      eventId: typeof suppliedId === 'string' ? suppliedId.slice(0, 200) : null,
      type: null,
      duplicate: false,
      receivedAt: new Date(now()).toISOString(),
      signatureValid,
    };
    if (!signatureValid) {
      record(receipt);
      throw new HttpError(401, 'Invalid webhook signature or timestamp');
    }
    const event = parseJson(raw);
    if (typeof event.id !== 'string' || !event.id.trim() || event.id.length > 200
      || typeof event.type !== 'string' || !event.type.trim() || event.type.length > 200
      || typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt))
      || !Object.hasOwn(event, 'payload') || suppliedId !== event.id) {
      record(receipt);
      throw new HttpError(400, 'Invalid event envelope or mismatched X-Relay-Event-Id');
    }
    receipt.type = event.type;
    receipt.duplicate = effects.has(event.id);
    record(receipt);
    if (receipt.duplicate) {
      duplicateCount += 1;
      json(response, 200, { accepted: true, duplicate: true, eventId: event.id });
      return;
    }

    const { mode, delayMs } = config;
    if (mode === 'fail' || (mode === 'flaky' && config.failuresRemaining > 0)) {
      if (mode === 'flaky') config.failuresRemaining -= 1;
      json(response, 503, { error: 'Simulated temporary failure' });
      return;
    }
    const generation = resetGeneration;
    if (mode === 'commit_then_timeout') applyEffect(event.id);
    if (mode === 'timeout' || mode === 'commit_then_timeout') {
      const connected = await delayResponse(response, delayMs);
      if (!connected) return;
      if (generation !== resetGeneration) {
        json(response, 503, { error: 'Receiver was reset while processing' });
        return;
      }
    }
    if (mode !== 'commit_then_timeout') {
      // Multiple requests can overlap during timeout delays; recheck deduplication
      // when committing the effect, rather than only when receiving the request.
      if (!applyEffect(event.id)) {
        receipt.duplicate = true;
        duplicateCount += 1;
      }
    }
    json(response, 200, { accepted: true, duplicate: receipt.duplicate, eventId: event.id });
  }

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://receiver').pathname;
      if (request.method === 'GET' && path === '/health') {
        json(response, 200, { status: 'UP' });
        return;
      }
      if (request.method === 'POST' && path === '/webhook') {
        await webhook(request, response);
        return;
      }
      if (['/state', '/config', '/reset'].includes(path)) {
        if (!secureEqual(request.headers['x-api-key'], apiKey)) {
          throw new HttpError(401, 'Invalid or missing API key');
        }
        if (request.method === 'GET' && path === '/state') {
          json(response, 200, state());
          return;
        }
        if (request.method === 'POST' && path === '/config') {
          requireJson(request);
          updateConfig(parseJson(await readBody(request)));
          json(response, 200, state());
          return;
        }
        if (request.method === 'POST' && path === '/reset') {
          // Drain the bounded body even though reset doesn't need parameters.
          await readBody(request);
          resetGeneration += 1;
          receivedCount = 0;
          effectCount = 0;
          duplicateCount = 0;
          receipts = [];
          effects = new Set();
          json(response, 200, state());
          return;
        }
        json(response, 405, { error: 'Method not allowed' });
        return;
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : 'Internal receiver error',
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const apiKey = process.env.RELAY_API_KEY;
  const port = Number(process.env.PORT ?? 8081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  const server = createReceiver({ apiKey, signingSecret: process.env.RECEIVER_SIGNING_SECRET ?? '' });
  server.listen(port, '0.0.0.0', () => console.log(`Relay demo receiver listening on ${port}`));
  const shutdown = () => {
    server.close();
    const force = setTimeout(() => server.closeAllConnections(), 5000);
    force.unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
