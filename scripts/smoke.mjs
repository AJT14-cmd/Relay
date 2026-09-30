import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');
const base = process.env.RELAY_URL ?? `http://localhost:${process.env.DASHBOARD_PORT ?? '3000'}`;
const key = process.env.RELAY_API_KEY ?? 'relay-local-dev-key';
async function request(path, body, expected = 200) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  assert.equal(response.status, expected, path + ': ' + text);
  return text ? JSON.parse(text) : null;
}
async function waitFor(id, state) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const result = await request('/api/deliveries/' + id);
    if (result.status === state) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Delivery failed to reach ' + state);
}
const endpoint = await request('/api/endpoints', { url: 'http://receiver:8081/webhook' }, 201);
const prefix = 'smoke-' + crypto.randomUUID();
try {
  await request('/receiver-api/reset', {});
  await request('/receiver-api/config', { mode: 'flaky', failuresRemaining: 2, signingSecret: endpoint.signingSecret });
  const event = { id: prefix + '-retry', endpointId: endpoint.id, type: 'order.created', payload: { orderId: 42 } };
  const accepted = await request('/api/events', event, 202);
  const delivered = await waitFor(accepted.deliveryId, 'SUCCEEDED');
  assert.equal(delivered.attemptCount, 3);
  await request('/api/events', event, 200);
  await request('/api/events', { ...event, payload: { orderId: 43 } }, 409);
  await request('/receiver-api/config', { mode: 'fail' });
  const exhausted = await request('/api/events', { ...event, id: prefix + '-replay' }, 202);
  await waitFor(exhausted.deliveryId, 'EXHAUSTED');
  await request('/receiver-api/config', { mode: 'success' });
  await request('/api/deliveries/' + exhausted.deliveryId + '/replay', {});
  const replayed = await waitFor(exhausted.deliveryId, 'SUCCEEDED');
  assert.equal(replayed.replayCount, 1);
  await request('/receiver-api/config', { mode: 'commit_then_timeout', delayMs: 5000 });
  const duplicate = await request('/api/events', { ...event, id: prefix + '-duplicate' }, 202);
  await waitFor(duplicate.deliveryId, 'SUCCEEDED');
  const state = await request('/receiver-api/state');
  assert.equal(state.effectCount, 3);
  assert.ok(state.duplicateCount >= 1);
  console.log('PASS: signed retries, idempotency/conflicts, exhaustion/replay and deduplicated timeout delivery');
} finally {
  await request('/api/endpoints/' + endpoint.id + '/disable', {});
  await request('/receiver-api/config', { mode: 'success' });
}
