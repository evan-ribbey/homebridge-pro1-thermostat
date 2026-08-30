import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { Pro1Client } from '../src/pro1Client.js';

const realFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('getSystemInfo returns parsed JSON on 200', async () => {
  globalThis.fetch = (async () => jsonResponse(200, { model: 'T705' })) as typeof fetch;
  const client = new Pro1Client('192.0.2.1');
  const info = await client.getSystemInfo();
  assert.equal(info.model, 'T705');
});

test('getSystemInfo calls /sys with an abort signal', async () => {
  let url = '';
  let signal: AbortSignal | null = null;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    url = String(input);
    signal = (init?.signal as AbortSignal) ?? null;
    return jsonResponse(200, {});
  }) as typeof fetch;
  const client = new Pro1Client('192.0.2.1', 8080, 250);
  await client.getSystemInfo();
  assert.equal(url, 'http://192.0.2.1:8080/sys');
  assert.ok(signal !== null);
});

test('getSystemTime returns parsed JSON on 200', async () => {
  globalThis.fetch = (async () => jsonResponse(200, { epoch: 1700000000 })) as typeof fetch;
  const client = new Pro1Client('192.0.2.1');
  const time = await client.getSystemTime();
  assert.equal(time.epoch, 1700000000);
});

test('getSystemInfo throws on non-200', async () => {
  globalThis.fetch = (async () => jsonResponse(500, { error: 'boom' })) as typeof fetch;
  const client = new Pro1Client('192.0.2.1');
  await assert.rejects(() => client.getSystemInfo(), /HTTP 500/);
});

test('getSystemInfo propagates an abort/timeout error', async () => {
  const client = new Pro1Client('192.0.2.1');
  globalThis.fetch = (async () => {
    throw new DOMException('The operation was aborted', 'AbortError');
  }) as typeof fetch;
  await assert.rejects(() => client.getSystemInfo(), (error: unknown) => (error as Error).name === 'AbortError');
});
