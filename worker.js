import { connect } from 'cloudflare:sockets';
import { createBackend } from './core.mjs';

export default createBackend(connect);
