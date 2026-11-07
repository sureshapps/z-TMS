// Request-scoped MQTT 3.1.1 connection probe. No PUBLISH or SUBSCRIBE support.
const encoder = new TextEncoder();

export class ProbeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function mqttString(value) {
  const bytes = encoder.encode(value);
  if (bytes.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProbeError('INVALID_CONFIG', 'MQTT identity fields are invalid or too long.');
  }
  return [bytes.length >> 8, bytes.length & 255, ...bytes];
}

export function connectPacket(clientId, username, password) {
  // Clean session; no Last Will; username and password; keepalive 15 seconds.
  const body = [0, 4, 77, 81, 84, 84, 4, 0xc2, 0, 15,
    ...mqttString(clientId), ...mqttString(username), ...mqttString(password)];
  const length = [];
  let remaining = body.length;
  do { const digit = remaining % 128; remaining = Math.floor(remaining / 128); length.push(digit | (remaining ? 128 : 0)); } while (remaining);
  return new Uint8Array([0x10, ...length, ...body]);
}

export function configuration(env) {
  const required = ['MQTT_HOST', 'MQTT_PORT', 'MQTT_CLIENT_ID', 'MQTT_USERNAME', 'MQTT_PASSWORD', 'TERMINAL_CLIENT_ID'];
  if (required.some(key => !String(env[key] || '').trim())) {
    throw new ProbeError('MISSING_CONFIG', 'Configure the MQTT variables and secrets first.');
  }
  const clientId = env.MQTT_CLIENT_ID.trim();
  const terminalId = env.TERMINAL_CLIENT_ID.trim();
  // Also reject a changed signing suffix with the same terminal identity.
  if (clientId.split('|')[0] === terminalId.split('|')[0]) {
    throw new ProbeError('DUPLICATE_CLIENT_ID', 'Use a broker-issued panel client ID and matching credentials, separate from the terminal.');
  }
  const port = Number(env.MQTT_PORT);
  const host = env.MQTT_HOST.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new ProbeError('INVALID_CONFIG', 'Check the MQTT host and port.');
  }
  const tls = env.MQTT_TLS || 'off';
  if (!['on', 'off'].includes(tls)) throw new ProbeError('INVALID_CONFIG', 'MQTT_TLS must be on or off.');
  return { host, port, tls, clientId, username: env.MQTT_USERNAME, password: env.MQTT_PASSWORD };
}

export async function probe(connect, config, timeoutMs = 8000) {
  let socket, reader, writer, timer;
  // Bound all stages, including TCP open, write, read and graceful disconnect.
  const operation = async () => {
    socket = connect({ hostname: config.host, port: config.port }, { secureTransport: config.tls });
    // Cloudflare's closed promise can reject independently of opened/read.
    socket.closed?.catch(() => {});
    await socket.opened;
    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();
    await writer.write(connectPacket(config.clientId, config.username, config.password));
    let received = new Uint8Array();
    while (received.length < 4) {
      const { value, done } = await reader.read();
      if (done) throw new ProbeError('BROKER_CLOSED', 'Broker closed the connection before acknowledging MQTT.');
      if (!value?.length) continue;
      if (received.length + value.length > 4096) throw new ProbeError('INVALID_RESPONSE', 'Broker returned an unexpected MQTT response.');
      const combined = new Uint8Array(received.length + value.length);
      combined.set(received); combined.set(value, received.length); received = combined;
    }
    // A clean-session CONNECT must receive session-present=0.
    if (received[0] !== 0x20 || received[1] !== 2 || received[2] !== 0 || received[3] > 5) {
      throw new ProbeError('INVALID_RESPONSE', 'Broker did not return a valid MQTT 3.1.1 CONNACK.');
    }
    const reasons = ['', 'Unsupported MQTT version.', 'Client ID rejected.', 'Broker unavailable.', 'Username or password rejected.', 'Not authorized by broker.'];
    if (received[3] !== 0) throw new ProbeError('MQTT_REJECTED', reasons[received[3]]);
    await writer.write(new Uint8Array([0xe0, 0]));
    return { ok: true, authenticated: true, protocol: 'MQTT 3.1.1', published: false, subscribed: false };
  };
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ProbeError('TIMEOUT', 'MQTT connection timed out. Check broker reachability and firewall rules.')), timeoutMs);
    })]);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    // Do not echo socket errors or broker configuration into public logs/responses.
    throw new ProbeError('CONNECTION_FAILED', 'Could not establish the MQTT connection. Check the host, transport, and broker access rules.');
  } finally {
    clearTimeout(timer);
    try { writer?.releaseLock(); } catch {}
    try { reader?.cancel().catch(() => {}); } catch {}
    try { socket?.close().catch(() => {}); } catch {}
  }
}

async function authenticated(request, expected) {
  if (typeof expected !== 'string' || expected.length < 32) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ') || header.length > 512) return false;
  const digest = text => crypto.subtle.digest('SHA-256', encoder.encode(text));
  const [a, b] = await Promise.all([digest(header.slice(7)), digest(expected)]);
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left[i] ^ right[i];
  return different === 0;
}

export function createBackend(connect) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const origin = request.headers.get('Origin');
      const allowed = env.PANEL_ORIGIN && origin === env.PANEL_ORIGIN;
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' };
      if (allowed) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
      const response = (value, code = 200) => new Response(JSON.stringify(value), { status: code, headers });
      if (origin && !allowed) return response({ error: 'Origin not allowed.' }, 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers });
      if (url.pathname === '/health' && request.method === 'GET') return response({ ok: true, service: 'tms-mqtt-connection-probe', commandsEnabled: false });
      if (url.pathname !== '/api/mqtt/test') return response({ error: 'Not found. Publishing and subscriptions are not implemented in this connection-probe package.' }, 404);
      if (request.method !== 'POST') return response({ error: 'Use POST.' }, 405);
      if (!await authenticated(request, env.ADMIN_TOKEN)) return response({ error: 'Unauthorized. Configure ADMIN_TOKEN and send a matching bearer token.' }, 401);
      if (!env.DB) return response({ error: 'Bind the D1 database as DB and apply schema.sql.' }, 503);
      const requestId = crypto.randomUUID();
      try {
        const config = configuration(env);
        // Shared five-per-minute limit prevents repeated connections with one panel ID.
        const bucket = Math.floor(Date.now() / 60000);
        const limit = await env.DB.prepare('INSERT INTO probe_limits (bucket, attempts) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts').bind(bucket).first();
        if (!limit || limit.attempts > 5) return response({ error: 'Connection-test limit reached. Try again next minute.' }, 429);
        // Durable lease prevents concurrent tests from kicking each other off MQTT.
        const leaseExpiry = Date.now() + 15000;
        const lease = await env.DB.prepare("UPDATE probe_lock SET expires_at = ? WHERE id = 1 AND expires_at < ? RETURNING id").bind(leaseExpiry, Date.now()).first();
        if (!lease) return response({ error: 'Another connection test is running. Try again shortly.' }, 409);
        let result;
        try {
          result = await probe(connect, config);
          await env.DB.prepare('INSERT INTO mqtt_probe_log (id, created_at, result) VALUES (?, ?, ?)').bind(requestId, new Date().toISOString(), 'connected').run();
          return response({ ...result, requestId, message: 'Broker accepted the panel login. No device commands were sent. This does not verify terminal status or topic permissions.' });
        } catch (error) {
          if (!(error instanceof ProbeError)) throw error;
          await env.DB.prepare('INSERT INTO mqtt_probe_log (id, created_at, result) VALUES (?, ?, ?)').bind(requestId, new Date().toISOString(), error.code).run();
          return response({ ok: false, code: error.code, message: error.message, requestId }, 502);
        } finally {
          await env.DB.prepare('UPDATE probe_lock SET expires_at = 0 WHERE id = 1 AND expires_at = ?').bind(leaseExpiry).run();
        }
      } catch (error) {
        if (error instanceof ProbeError) return response({ ok: false, code: error.code, message: error.message }, 400);
        return response({ ok: false, code: 'BACKEND_ERROR', message: 'Check the D1 binding and schema. No secret details are returned.', requestId }, 503);
      }
    }
  };
}
