import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createReceiver } from '../src/server.js';

const API_KEY = 'test-management-key';
const SECRET = 'test-webhook-signing-secret';
const NOW = Date.parse('2026-09-29T12:00:00Z');

async function fixture(t, options = {}) {
  const server = createReceiver({ apiKey: API_KEY, signingSecret: SECRET, now: () => NOW, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  async function call(path, { method = 'GET', body, headers = {}, ...rest } = {}) {
    return fetch(base + path, {
      method,
      headers: { 'X-API-Key': API_KEY, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...rest,
    });
  }
  async function configure(body) {
    const response = await call('/config', { method: 'POST', body });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function state() { return (await call('/state')).json(); }
  async function send({ id = 'event-1', type = 'order.created', timestamp = Math.floor(NOW / 1000),
    secret = SECRET, body, signature, headers = {}, signal } = {}) {
    const raw = body ?? JSON.stringify({ id, type, createdAt: new Date(NOW).toISOString(), payload: { amount: 42 } });
    const calculated = 'v1=' + createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
    return fetch(base + '/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Timestamp': String(timestamp),
        'X-Relay-Signature': signature ?? calculated,
        'X-Relay-Event-Id': id,
        ...headers,
      },
      body: raw,
      signal,
    });
  }
  return { base, call, configure, state, send };
}

test('a management key is required; only health is public', async (t) => {
  assert.throws(() => createReceiver(), /RELAY_API_KEY/);
  const receiver = await fixture(t);
  assert.equal((await fetch(receiver.base + '/health')).status, 200);
  for (const [path, method] of [['/state', 'GET'], ['/config', 'POST'], ['/reset', 'POST']]) {
    assert.equal((await fetch(receiver.base + path, { method })).status, 401);
    assert.equal((await receiver.call(path, { method, headers: { 'X-API-Key': 'wrong-key' } })).status, 401);
  }
  assert.equal((await receiver.call('/state', { method: 'POST' })).status, 405);
  assert.equal((await receiver.call('/missing')).status, 404);
});

test('valid signatures cover the exact bytes, including whitespace and Unicode', async (t) => {
  const receiver = await fixture(t);
  const body = '{ "id": "event-1", "type": "order.created", "createdAt": "2026-09-29T12:00:00Z", "payload": { "note": "café ☕" } }';
  const response = await receiver.send({ body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, duplicate: false, eventId: 'event-1' });
  const state = await receiver.state();
  assert.equal(state.receivedCount, 1);
  assert.equal(state.effectCount, 1);
  assert.equal(state.receipts[0].signatureValid, true);
});

test('invalid, stale, future, and malformed signatures never produce effects', async (t) => {
  const receiver = await fixture(t);
  const attempts = [
    { secret: 'wrong-signing-secret' },
    { signature: 'v1=abc' },
    { timestamp: Math.floor(NOW / 1000) - 301 },
    { timestamp: Math.floor(NOW / 1000) + 301 },
    { headers: { 'X-Relay-Timestamp': 'invalid' } },
    { headers: { 'X-Relay-Signature': '' } },
  ];
  for (const attempt of attempts) assert.equal((await receiver.send(attempt)).status, 401);
  const state = await receiver.state();
  assert.equal(state.effectCount, 0);
  assert.equal(state.receivedCount, attempts.length);
  assert.ok(state.receipts.every((receipt) => !receipt.signatureValid));
});

test('a signature cannot be reused after the raw body changes', async (t) => {
  const receiver = await fixture(t);
  const body = JSON.stringify({ id: 'event-1', type: 'order.created', createdAt: new Date(NOW).toISOString(), payload: 1 });
  const timestamp = Math.floor(NOW / 1000);
  const signature = 'v1=' + createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  assert.equal((await receiver.send({ body: body + ' ', signature })).status, 401);
  assert.equal((await receiver.state()).effectCount, 0);
});

test('missing receiver secret fails closed until configured', async (t) => {
  const receiver = await fixture(t, { signingSecret: '' });
  assert.equal((await receiver.send()).status, 503);
  assert.equal((await receiver.state()).signingSecretConfigured, false);
  await receiver.configure({ signingSecret: SECRET });
  assert.equal((await receiver.send()).status, 200);
});

test('deduplicates effects by event ID even when retry bodies differ', async (t) => {
  const receiver = await fixture(t);
  const results = await Promise.all([receiver.send(), receiver.send({ type: 'different.type' })]);
  assert.ok(results.every((response) => response.status === 200));
  const bodies = await Promise.all(results.map((response) => response.json()));
  assert.equal(bodies.filter((body) => body.duplicate).length, 1);
  const state = await receiver.state();
  assert.equal(state.receivedCount, 2);
  assert.equal(state.effectCount, 1);
  assert.equal(state.duplicateCount, 1);
  await receiver.configure({ mode: 'fail' });
  assert.equal((await receiver.send()).status, 200, 'already committed duplicates are always acknowledged');
});

test('flaky fails the configured number of attempts then succeeds', async (t) => {
  const receiver = await fixture(t);
  await receiver.configure({ mode: 'flaky', failuresRemaining: 2 });
  assert.equal((await receiver.send()).status, 503);
  assert.equal((await receiver.send()).status, 503);
  assert.equal((await receiver.state()).effectCount, 0);
  assert.equal((await receiver.send()).status, 200);
  const state = await receiver.state();
  assert.equal(state.failuresRemaining, 0);
  assert.equal(state.receivedCount, 3);
  assert.equal(state.effectCount, 1);
  assert.equal(state.duplicateCount, 0);
});

test('fail mode requires a configuration change before uncommitted work succeeds', async (t) => {
  const receiver = await fixture(t);
  await receiver.configure({ mode: 'fail' });
  assert.equal((await receiver.send()).status, 503);
  assert.equal((await receiver.send()).status, 503);
  await receiver.configure({ mode: 'success' });
  assert.equal((await receiver.send()).status, 200);
  assert.equal((await receiver.state()).effectCount, 1);
});

test('timeout cancels its pending effect when the caller disconnects', async (t) => {
  const receiver = await fixture(t);
  await receiver.configure({ mode: 'timeout', delayMs: 100 });
  await assert.rejects(receiver.send({ signal: AbortSignal.timeout(30) }));
  await sleep(120);
  assert.equal((await receiver.state()).effectCount, 0);
  await receiver.configure({ mode: 'success' });
  assert.equal((await receiver.send()).status, 200);
  assert.equal((await receiver.state()).duplicateCount, 0);
});

test('commit then timeout demonstrates response loss without repeating an effect', async (t) => {
  const receiver = await fixture(t);
  await receiver.configure({ mode: 'commit_then_timeout', delayMs: 500 });
  await assert.rejects(receiver.send({ signal: AbortSignal.timeout(50) }));
  assert.equal((await receiver.state()).effectCount, 1);
  const retry = await receiver.send();
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  const state = await receiver.state();
  assert.equal(state.receivedCount, 2);
  assert.equal(state.effectCount, 1);
  assert.equal(state.duplicateCount, 1);
});

test('overlapping delayed deliveries still produce only one effect', async (t) => {
  const receiver = await fixture(t);
  await receiver.configure({ mode: 'timeout', delayMs: 20 });
  const results = await Promise.all([receiver.send(), receiver.send()]);
  assert.ok(results.every((response) => response.status === 200));
  const state = await receiver.state();
  assert.equal(state.effectCount, 1);
  assert.equal(state.duplicateCount, 1);
});

test('configuration updates are validated atomically and never echo secrets', async (t) => {
  const receiver = await fixture(t);
  const updated = await receiver.configure({ mode: 'flaky', failuresRemaining: 3, delayMs: 10, signingSecret: 'new-secret' });
  assert.equal(updated.signingSecretConfigured, true);
  assert.ok(!JSON.stringify(updated).includes('new-secret'));
  const cases = [{ mode: 'invalid' }, { failuresRemaining: -1 }, { failuresRemaining: 1.5 },
    { delayMs: 60001 }, { signingSecret: '' }, { signingSecret: null }, { mystery: true },
    { mode: 'success', delayMs: -1 }];
  for (const body of cases) assert.equal((await receiver.call('/config', { method: 'POST', body })).status, 400);
  const state = await receiver.state();
  assert.equal(state.mode, 'flaky');
  assert.equal(state.failuresRemaining, 3);
  assert.equal(state.delayMs, 10);
  assert.ok(!JSON.stringify(state).includes(SECRET));
  assert.ok(!JSON.stringify(state).includes('new-secret'));
});

test('invalid envelopes and mismatched IDs cannot produce effects', async (t) => {
  const receiver = await fixture(t);
  const bodies = ['invalid json', '{}', '[]', 'null',
    JSON.stringify({ id: 'different', type: 'order.created', createdAt: new Date(NOW).toISOString(), payload: {} }),
    JSON.stringify({ id: 'event-1', type: 'order.created', createdAt: 'not a date', payload: {} }),
    JSON.stringify({ id: 'event-1', type: 'order.created', createdAt: new Date(NOW).toISOString() })];
  for (const body of bodies) assert.equal((await receiver.send({ body })).status, 400);
  assert.equal((await receiver.state()).effectCount, 0);
});

test('rejects oversized bodies and unsupported content types', async (t) => {
  const receiver = await fixture(t);
  assert.equal((await receiver.send({ body: 'x'.repeat(256 * 1024 + 1) })).status, 413);
  assert.equal((await receiver.send({ headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await receiver.state()).effectCount, 0);
});

test('retains only 100 receipts while retaining deduplication until reset', async (t) => {
  const receiver = await fixture(t);
  for (let index = 0; index < 101; index++) assert.equal((await receiver.send({ id: `event-${index}` })).status, 200);
  const state = await receiver.state();
  assert.equal(state.receipts.length, 100);
  assert.equal(state.receipts[0].eventId, 'event-1');
  assert.equal(state.effectCount, 101);
  assert.equal((await receiver.send({ id: 'event-0' })).status, 200);
  assert.equal((await receiver.state()).duplicateCount, 1);
  await receiver.configure({ mode: 'flaky', failuresRemaining: 1, delayMs: 20 });
  const reset = await receiver.call('/reset', { method: 'POST' });
  const cleared = await reset.json();
  assert.equal(cleared.effectCount, 0);
  assert.equal(cleared.receivedCount, 0);
  assert.deepEqual(cleared.receipts, []);
  assert.equal(cleared.mode, 'flaky');
  assert.equal(cleared.failuresRemaining, 1);
  assert.equal(cleared.signingSecretConfigured, true);
  assert.equal((await receiver.send({ id: 'event-0' })).status, 503);
  assert.equal((await receiver.send({ id: 'event-0' })).status, 200);
  assert.equal((await receiver.state()).duplicateCount, 0);
});

test('reset prevents in-flight delayed work from populating a new demonstration', async (t) => {
  const receiver = await fixture(t);
  await receiver.configure({ mode: 'timeout', delayMs: 100 });
  const pending = receiver.send();
  for (let attempt = 0; attempt < 100 && (await receiver.state()).receivedCount === 0; attempt++) await sleep(1);
  assert.equal((await receiver.state()).receivedCount, 1);
  await receiver.call('/reset', { method: 'POST' });
  assert.equal((await pending).status, 503);
  const state = await receiver.state();
  assert.equal(state.effectCount, 0);
  assert.equal(state.receivedCount, 0);
  assert.deepEqual(state.receipts, []);
});
