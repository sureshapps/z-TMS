import { readFile, writeFile } from 'node:fs/promises';
const core = await readFile(new URL('./core.mjs', import.meta.url), 'utf8');
await writeFile(new URL('./dashboard-worker.js', import.meta.url),
  "import { connect } from 'cloudflare:sockets';\n\n" + core + '\nexport default createBackend(connect);\n');
console.log('Created dashboard-worker.js for the Cloudflare dashboard editor.');
