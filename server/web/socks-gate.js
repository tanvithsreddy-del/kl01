import net from 'node:net';
import { authorizeDestination, isPublicAddress, WEB_PORTS } from './policy.js';
import { fail } from '../lib/errors.js';
import { connectThroughProxy, parseUpstreamProxy } from './upstream-proxy.js';

const SOCKS_VERSION = 5;
const NO_AUTH = 0;
const CONNECT = 1;
const ATYP_V4 = 1;
const ATYP_DOMAIN = 3;
const ATYP_V6 = 4;
const HANDSHAKE_TIMEOUT_MS = 5_000;

function replyBytes(code) { return Buffer.from([SOCKS_VERSION, code, 0, ATYP_V4, 0,0,0,0, 0,0]); }
function reply(socket, code) { if (!socket.destroyed) socket.write(replyBytes(code)); }
function deny(socket, code) { if (!socket.destroyed) socket.end(replyBytes(code)); }

function readExactly(socket, bytes, { signal, timeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let timer; let settled = false;
    const cleanup = () => {
      clearTimeout(timer); socket.off('readable', onReadable); socket.off('error', onError); socket.off('close', onClose); socket.off('end', onClose); signal?.removeEventListener('abort', onAbort);
    };
    const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
    const tryRead = () => {
      const value = socket.read(bytes);
      if (value && value.length === bytes) { finish(resolve, value); return true; }
      return false;
    };
    const onReadable = () => { tryRead(); };
    const onError = error => finish(reject, error);
    const onClose = () => finish(reject, new Error('socket closed'));
    const onAbort = () => { socket.destroy(); finish(reject, fail('WEB_CANCELLED', 'Web work was stopped.', 499)); };
    socket.on('readable', onReadable); socket.once('error', onError); socket.once('close', onClose); socket.once('end', onClose);
    signal?.addEventListener('abort', onAbort, { once:true });
    timer = setTimeout(() => { socket.destroy(); finish(reject, fail('WEB_SOCKS_TIMEOUT', 'Browser network setup timed out.', 504)); }, timeoutMs);
    tryRead();
  });
}

function ipv6FromBytes(bytes) {
  const groups=[];
  for (let i=0;i<16;i+=2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(':');
}

function parsePort(bytes) { return bytes.readUInt16BE(0); }

async function vettedTargets(host, port, lookup) {
  if (!WEB_PORTS.has(port)) throw fail('WEB_PORT_BLOCKED', 'Web currently opens only standard web ports.', 403);
  const family = net.isIP(host);
  if (family) {
    if (!isPublicAddress(host)) throw fail('WEB_DESTINATION_BLOCKED', 'KL01 blocked browser traffic to this computer or a private network.', 403);
    return [{ address:host, family }];
  }
  const authorized = await authorizeDestination(`https://${host}:${port}/`, { ...(lookup ? { lookup } : {}) });
  return authorized.addresses;
}

function connectOne(address, port, { signal, timeoutMs = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail('WEB_CANCELLED', 'Web work was stopped.', 499));
    const socket = net.connect({ host:address.address, port, family:address.family });
    let settled=false; const timer=setTimeout(() => { socket.destroy(); done(reject, new Error('connect timeout')); }, timeoutMs);
    const done=(fn,value)=>{ if(settled)return; settled=true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); socket.off('error', onError); socket.off('connect', onConnect); fn(value); };
    const onAbort=()=>{ socket.destroy(); done(reject, fail('WEB_CANCELLED','Web work was stopped.',499)); };
    const onError=error=>done(reject,error);
    const onConnect=()=>{ socket.on('error',()=>{}); done(resolve,socket); };
    socket.once('error',onError); socket.once('connect',onConnect); signal?.addEventListener('abort',onAbort,{once:true});
  });
}

async function connectVetted(addresses, port, options = {}) {
  let lastError;
  for (const address of addresses) {
    try { return await connectOne(address, port, options); }
    catch (error) { lastError = error; if (options.signal?.aborted) throw error; }
  }
  throw lastError || new Error('no vetted address connected');
}

async function handleClient(client, { signal, lookup, onConnection, upstreamProxy }) {
  client.setNoDelay(true);
  let upstream = null;
  try {
    const hello = await readExactly(client, 2, { signal });
    if (hello[0] !== SOCKS_VERSION || hello[1] < 1 || hello[1] > 16) throw new Error('bad greeting');
    const methods = await readExactly(client, hello[1], { signal });
    if (!methods.includes(NO_AUTH)) { client.end(Buffer.from([SOCKS_VERSION, 0xff])); return; }
    client.write(Buffer.from([SOCKS_VERSION, NO_AUTH]));

    const head = await readExactly(client, 4, { signal });
    if (head[0] !== SOCKS_VERSION || head[1] !== CONNECT || head[2] !== 0) { deny(client, 7); return; }
    let host;
    if (head[3] === ATYP_V4) host = [...await readExactly(client, 4, { signal })].join('.');
    else if (head[3] === ATYP_V6) host = ipv6FromBytes(await readExactly(client, 16, { signal }));
    else if (head[3] === ATYP_DOMAIN) {
      const length = (await readExactly(client, 1, { signal }))[0];
      if (!length || length > 253) { deny(client, 8); return; }
      host = (await readExactly(client, length, { signal })).toString('utf8');
    } else { deny(client, 8); return; }
    const port = parsePort(await readExactly(client, 2, { signal }));
    const addresses = await vettedTargets(host, port, lookup);
    upstream = upstreamProxy
      ? await connectThroughProxy(upstreamProxy, addresses, port, { signal })
      : await connectVetted(addresses, port, { signal });
    onConnection?.({ host, port, addresses, proxied:Boolean(upstreamProxy), proxyType:upstreamProxy?.type || null });
    reply(client, 0);
    client.pipe(upstream); upstream.pipe(client);
    const closeOther = source => () => { try { source.destroy(); } catch {} };
    client.once('close', closeOther(upstream)); upstream.once('close', closeOther(client));
    client.once('error', closeOther(upstream)); upstream.once('error', closeOther(client));
  } catch (error) {
    if (!client.destroyed) {
      try { deny(client, error?.code === 'WEB_DESTINATION_BLOCKED' || error?.code === 'WEB_PORT_BLOCKED' ? 2 : 1); } catch { client.destroy(); }
    }
    upstream?.destroy();
  }
}

export async function createSocksGate({ lookup = null, signal = null, onConnection = null, upstreamProxy = null } = {}) {
  const parsedProxy = upstreamProxy ? parseUpstreamProxy(upstreamProxy) : null;
  const clients = new Set();
  const server = net.createServer(client => {
    // Keep a terminal error sink for browser-created sockets across handshake
    // listener transitions; policy handlers still observe errors while active.
    client.on('error',()=>{});
    const peer = String(client.remoteAddress || '').toLowerCase();
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
      client.destroy();
      return;
    }
    clients.add(client); client.once('close', () => clients.delete(client));
    handleClient(client, { signal, lookup, onConnection, upstreamProxy:parsedProxy }).catch(() => { try { client.destroy(); } catch {} });
  });
  server.maxConnections = 128;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const close = async () => {
    for (const client of clients) client.destroy();
    await new Promise(resolve => server.close(() => resolve()));
  };
  signal?.addEventListener('abort', () => { close().catch(() => {}); }, { once:true });
  return { host:'127.0.0.1', port:address.port, url:`socks5://127.0.0.1:${address.port}`, close, server, upstreamProxy:parsedProxy ? { configured:true, type:parsedProxy.type } : null };
}
