# TMS Cloudflare MQTT connection probe

This is the first backend stage: an authenticated, time-limited MQTT 3.1.1 login test. It does not publish, subscribe, process payments, implement panel record APIs, or monitor devices continuously. It is not wired into the current demo frontend. No real broker has been contacted during development.

## Before testing

Obtain a separate **panel MQTT client ID, username and matching password** from the broker administrator. Do not reuse the terminal's client ID. The provided terminal ID uses an HMAC signing scheme; simply editing its client ID may invalidate its credentials. The backend rejects the known terminal identity, including when only its suffix is changed.

Port 1883 with `MQTT_TLS=off` sends MQTT credentials and data without transport encryption. Ask the broker administrator for a TLS hostname and port if supported; then set `MQTT_TLS=on`. Do not select TLS on the existing plain-text listener without confirming support.

## Dashboard deployment (no command line required)

1. Cloudflare dashboard → **Workers & Pages** → **Create application** → create a **Worker** (Hello World). Name it `tms-api` and deploy the placeholder.
2. Open **Edit code**. Replace its code with the complete contents of `dashboard-worker.js`, including the first `cloudflare:sockets` import. Deploy.
3. **Storage & databases → D1 SQL Database** → create or select `tms-db`. Open **Console**, paste all of `schema.sql`, and execute it.
4. Worker → **Bindings → Add binding → D1 database**. Variable name: **DB**. Select `tms-db`. Save/deploy.
5. Worker → **Settings → Variables and Secrets**. Add these as text variables:

   | Name | Value |
   |---|---|
   | `MQTT_HOST` | Your broker address (currently `103.191.132.54`) |
   | `MQTT_PORT` | `1883` for the provided listener |
   | `MQTT_TLS` | `off` for the provided listener; `on` only for a confirmed TLS listener |
   | `TERMINAL_CLIENT_ID` | `00078020708` |
   | `PANEL_ORIGIN` | Exact HTTPS origin of your panel, with no trailing slash |

6. Add these using type **Secret**, not Text:

   | Name | Value |
   |---|---|
   | `ADMIN_TOKEN` | A unique random token of at least 32 characters |
   | `MQTT_CLIENT_ID` | Broker-issued **panel** client ID |
   | `MQTT_USERNAME` | Matching panel MQTT username |
   | `MQTT_PASSWORD` | Matching panel MQTT password |

   Generate an administrator token locally in PowerShell with:

   ```powershell
   [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
   ```

   Keep it private. Do not place it in frontend JavaScript, URLs, or public repositories.

7. Deploy the settings. Open `https://YOUR-WORKER.workers.dev/health`. Expected:

   ```json
   { "ok": true, "service": "tms-mqtt-connection-probe", "commandsEnabled": false }
   ```

   Health confirms only that the HTTP Worker is running, not MQTT connectivity.

8. Test MQTT from Windows PowerShell (the token prompt hides input):

   ```powershell
   $tmsTokenSecure = Read-Host 'Enter ADMIN_TOKEN' -AsSecureString
   $tmsTokenPlain = [System.Net.NetworkCredential]::new('', $tmsTokenSecure).Password
   try {
     Invoke-RestMethod -Method Post `
       -Uri 'https://YOUR-WORKER.workers.dev/api/mqtt/test' `
       -Headers @{ Authorization = "Bearer $tmsTokenPlain" }
   } finally {
     Remove-Variable tmsTokenPlain, tmsTokenSecure -ErrorAction SilentlyContinue
   }
   ```

   Success means the broker accepted CONNECT. The Worker immediately disconnects without publishing, subscribing, or registering a Last Will. It does not prove the device is online or that the account may publish/subscribe to its topic.

## Errors

| Code/status | Meaning |
|---|---|
| `401` | Missing/wrong admin token, or configured token shorter than 32 characters |
| `DUPLICATE_CLIENT_ID` | Panel identity matches the terminal; request a separate account |
| `MISSING_CONFIG` | Required variable or secret is absent |
| `MQTT_REJECTED` | Broker rejected protocol, client ID, credentials, or authorization |
| `TIMEOUT` / `CONNECTION_FAILED` | Check listener, TLS mode, firewall, and allowlists |
| `503` | Check the DB binding and SQL schema |
| `409` | Another connection probe holds the shared lease; retry shortly |
| `429` | At most five authorized tests per minute |

## CLI alternative

Use Node.js with Cloudflare Wrangler. Edit `wrangler.jsonc`: replace the D1 database ID and panel origin. Keep the secrets out of this file.

```powershell
npx wrangler login
npx wrangler d1 execute tms-db --remote --file schema.sql
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put MQTT_CLIENT_ID
npx wrangler secret put MQTT_USERNAME
npx wrangler secret put MQTT_PASSWORD
```

## Next integration stage

Before adding real publish operations, obtain the terminal command schema and broker ACL/topic permissions, add proper panel authentication/authorization, and integrate the frontend with the API. Topic `/LLZN/00078020708` alone does not establish which payloads the terminal accepts or whether it is a command or telemetry topic. A permanently connected MQTT subscriber requires a separate lifecycle/reconnection design and is outside this probe package.

## Verification

Run `node --test backend.test.mjs`. Tests use in-memory mock sockets and database responses; they never connect to the broker. Regenerate `dashboard-worker.js` after source changes with `node build-dashboard.mjs`.

References: [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [D1 setup](https://developers.cloudflare.com/d1/get-started/), [MQTT 3.1.1](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html).
