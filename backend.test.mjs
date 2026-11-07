import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, connectPacket, probe, createBackend } from './core.mjs';

const token = 'test-only-admin-token-at-least-32-characters';
const envBase = {
  MQTT_HOST: 'broker.example.com', MQTT_PORT: '1883', MQTT_TLS: 'off',
  MQTT_CLIENT_ID: 'panel-separate-id', MQTT_USERNAME: 'panel-user', MQTT_PASSWORD: 'test-password',
  TERMINAL_CLIENT_ID: '00078020708', ADMIN_TOKEN: token,
  PANEL_ORIGIN: 'https://panel.example.com'
};

function fakeSocket(chunks, { hang = false } = {}) {
  const writes = [];
  let closed = false, controller;
  const socket = {
    opened: Promise.resolve(), closed: Promise.resolve(),
    readable: new ReadableStream({
      start(c) { controller = c; chunks.forEach(chunk => c.enqueue(new Uint8Array(chunk))); if (!hang) c.close(); }
    }),
    writable: new WritableStream({ write(data) { writes.push([...data]); } }),
    async close() { closed = true; try { controller.close(); } catch {} }
  };
  return { socket, writes, get closed() { return closed; } };
}

function fakeDB({ attempts = 1, locked = false } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) { statement.params = params; return statement; },
        async first() { calls.push({ sql, params: statement.params }); return sql.includes('probe_limits') ? { attempts } : locked ? null : { id: 1 }; },
        async run() { calls.push({ sql, params: statement.params }); return { success: true }; }
      };
      return statement;
    }
  };
}

const request = (path = '/api/mqtt/test', { auth = true, origin, method = 'POST' } = {}) => new Request('https://api.example.com' + path, {
  method, headers: { ...(auth ? { Authorization: 'Bearer ' + token } : {}), ...(origin ? { Origin: origin } : {}) }
});

test('CONNECT packet is MQTT 3.1.1 clean-session without Will, PUBLISH, or SUBSCRIBE', () => {
  const packet = connectPacket('panel', 'user', 'pass');
  assert.deepEqual([...packet], [16, 29, 0, 4, 77, 81, 84, 84, 4, 194, 0, 15,
    0, 5, 112, 97, 110, 101, 108, 0, 4, 117, 115, 101, 114, 0, 4, 112, 97, 115, 115]);
});

test('CONNECT handles multibyte remaining length and UTF-8 byte lengths', () => {
  const packet = connectPacket('é'.repeat(80), 'user', 'pass');
  assert.ok(packet[1] & 128);
  assert.equal(packet[2], 1);
  assert.deepEqual([...packet.slice(13, 15)], [0, 160]);
});

test('rejects missing configuration and duplicate terminal identity even with altered suffix', () => {
  assert.throws(() => configuration({}), { code: 'MISSING_CONFIG' });
  assert.throws(() => configuration({ ...envBase, MQTT_CLIENT_ID: '00078020708|different-suffix|' }), { code: 'DUPLICATE_CLIENT_ID' });
  assert.throws(() => configuration({ ...envBase, MQTT_PORT: 'not-a-port' }), { code: 'INVALID_CONFIG' });
});

test('accepts fragmented CONNACK and sends only CONNECT then DISCONNECT', async () => {
  const fake = fakeSocket([[0x20], [2, 0], [0]]);
  const result = await probe(() => fake.socket, configuration(envBase));
  assert.equal(result.authenticated, true);
  assert.equal(result.published, false);
  assert.equal(result.subscribed, false);
  assert.equal(fake.writes.length, 2);
  assert.equal(fake.writes[0][0], 0x10);
  assert.deepEqual(fake.writes[1], [0xe0, 0]);
  assert.equal(fake.closed, true);
});

test('rejects authentication failure, malformed packet, and truncated response', async () => {
  for (const [chunks, code] of [ [[[32, 2, 0, 4]], 'MQTT_REJECTED'], [[[48, 2, 0, 0]], 'INVALID_RESPONSE'], [[[32, 2]], 'BROKER_CLOSED'] ]) {
    const fake = fakeSocket(chunks);
    await assert.rejects(probe(() => fake.socket, configuration(envBase)), { code });
    assert.equal(fake.closed, true);
    assert.equal(fake.writes.length, 1);
  }
});

test('times out and closes a silent broker', async () => {
  const fake = fakeSocket([], { hang: true });
  await assert.rejects(probe(() => fake.socket, configuration(envBase), 20), { code: 'TIMEOUT' });
  assert.equal(fake.closed, true);
});

test('normalizes transport errors without leaking credentials', async () => {
  await assert.rejects(probe(() => { throw new Error(envBase.MQTT_PASSWORD); }, configuration(envBase)), error => {
    assert.equal(error.code, 'CONNECTION_FAILED');
    assert.ok(!error.message.includes(envBase.MQTT_PASSWORD));
    return true;
  });
});

test('health works without exposing broker details; unauthenticated requests never open sockets', async () => {
  let connections = 0;
  const api = createBackend(() => { connections++; throw new Error('Should not connect'); });
  const health = await api.fetch(request('/health', { method: 'GET', auth: false }), {});
  assert.equal(health.status, 200);
  assert.equal((await health.json()).commandsEnabled, false);
  const denied = await api.fetch(request(undefined, { auth: false }), envBase);
  assert.equal(denied.status, 401);
  assert.equal(connections, 0);
});

test('rejects cross-origin calls, requires D1, and leaves publishing unavailable', async () => {
  const api = createBackend(() => { throw new Error('Should not connect'); });
  assert.equal((await api.fetch(request(undefined, { origin: 'https://evil.example' }), envBase)).status, 403);
  const options = await api.fetch(request(undefined, { method: 'OPTIONS', origin: envBase.PANEL_ORIGIN }), envBase);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), envBase.PANEL_ORIGIN);
  assert.equal((await api.fetch(request(), envBase)).status, 503);
  assert.equal((await api.fetch(request('/api/mqtt/publish'), envBase)).status, 404);
});

test('enforces shared rate and concurrency limits before connecting', async () => {
  let connections = 0;
  const api = createBackend(() => { connections++; throw new Error('Should not connect'); });
  assert.equal((await api.fetch(request(), { ...envBase, DB: fakeDB({ attempts: 6 }) })).status, 429);
  assert.equal((await api.fetch(request(), { ...envBase, DB: fakeDB({ locked: true }) })).status, 409);
  assert.equal(connections, 0);
});

test('authenticated API probe records a secret-free audit result and releases only its lease', async () => {
  const DB = fakeDB();
  const fake = fakeSocket([[32, 2, 0, 0]]);
  const api = createBackend(() => fake.socket);
  const response = await api.fetch(request(), { ...envBase, DB });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.requestId);
  const audit = DB.calls.find(c => c.sql.includes('INSERT INTO mqtt_probe_log'));
  assert.equal(audit.params[2], 'connected');
  assert.ok(!JSON.stringify(DB.calls).includes(envBase.MQTT_PASSWORD));
  const release = DB.calls.at(-1);
  assert.ok(release.sql.includes('AND expires_at = ?'));
  assert.equal(release.params.length, 1);
});
