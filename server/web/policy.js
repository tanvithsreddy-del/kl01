import dns from 'node:dns/promises';
import net from 'node:net';
import { fail } from '../lib/errors.js';

export const WEB_PORTS = new Set([80, 443]);
const IPV4_SPECIAL = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4Number(value) {
  const parts = String(value).split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Range(address, base, prefix) {
  const a = ipv4Number(address); const b = ipv4Number(base);
  if (a === null || b === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (a & mask) === (b & mask);
}

function normalizeV6(input) {
  let value = String(input || '').toLowerCase();
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (value.includes('.')) {
    const last = value.lastIndexOf(':');
    const v4 = ipv4Number(value.slice(last + 1));
    if (v4 === null) return null;
    value = `${value.slice(0, last)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.map(group => parseInt(group, 16));
}

function v6Prefix(groups, bits) {
  let remaining = bits;
  const out = [];
  for (const group of groups) {
    if (remaining >= 16) { out.push(group); remaining -= 16; continue; }
    if (remaining <= 0) { out.push(0); continue; }
    out.push(group & (0xffff << (16 - remaining)));
    remaining = 0;
  }
  return out;
}

function sameV6Prefix(address, base, bits) {
  const a = normalizeV6(address); const b = normalizeV6(base);
  if (!a || !b) return false;
  const pa = v6Prefix(a, bits); const pb = v6Prefix(b, bits);
  return pa.every((value, index) => value === pb[index]);
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !IPV4_SPECIAL.some(([base, prefix]) => inV4Range(address, base, prefix));
  if (family !== 6) return false;
  const groups = normalizeV6(address);
  if (!groups) return false;
  // Unspecified/loopback, IPv4-mapped, discard-only, documentation, ULA, link-local, multicast.
  if (sameV6Prefix(address, '::', 128) || sameV6Prefix(address, '::1', 128)) return false;
  if (sameV6Prefix(address, '::ffff:0:0', 96)) {
    const v4 = `${(groups[6] >>> 8) & 255}.${groups[6] & 255}.${(groups[7] >>> 8) & 255}.${groups[7] & 255}`;
    return isPublicAddress(v4);
  }
  if (sameV6Prefix(address, '100::', 64)) return false;
  if (sameV6Prefix(address, '2001:db8::', 32)) return false;
  if (sameV6Prefix(address, 'fc00::', 7)) return false;
  if (sameV6Prefix(address, 'fe80::', 10)) return false;
  if (sameV6Prefix(address, 'ff00::', 8)) return false;
  // Only globally routable unicast is eligible. This also fails closed for
  // transition/local-use prefixes whose apparent address could tunnel to a
  // private IPv4 destination.
  if (!sameV6Prefix(address, '2000::', 3)) return false;
  if (sameV6Prefix(address, '2001::', 32)) return false; // Teredo
  if (sameV6Prefix(address, '2001:2::', 48)) return false; // benchmarking
  if (sameV6Prefix(address, '2001:20::', 28)) return false; // ORCHIDv2
  if (sameV6Prefix(address, '2002::', 16)) return false; // 6to4
  if (sameV6Prefix(address, '3fff::', 20)) return false; // documentation
  return true;
}

export function parseWebUrl(input) {
  let url;
  try { url = new URL(String(input || '')); }
  catch { throw fail('WEB_URL_INVALID', 'That web address is not valid.', 400); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('WEB_SCHEME_BLOCKED', 'Web can open only public HTTP or HTTPS pages.', 400);
  if (url.username || url.password) throw fail('WEB_CREDENTIAL_URL', 'Web addresses containing usernames or passwords are not allowed.', 400);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!WEB_PORTS.has(port)) throw fail('WEB_PORT_BLOCKED', 'Web currently opens only standard web ports.', 403);
  if (!url.hostname || url.hostname.length > 253) throw fail('WEB_HOST_INVALID', 'That web address has an invalid host.', 400);
  return { url, port };
}

export function orderValidatedAddresses(addresses = []) {
  const v4 = addresses.filter(item => Number(item?.family) === 4);
  const v6 = addresses.filter(item => Number(item?.family) === 6);
  const ordered = [];
  while (v4.length || v6.length) {
    if (v4.length) ordered.push(v4.shift());
    if (v6.length) ordered.push(v6.shift());
  }
  return ordered;
}

export async function authorizeDestination(input, { lookup = dns.lookup } = {}) {
  const { url, port } = parseWebUrl(input);
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1,-1) : url.hostname;
  const literalFamily = net.isIP(hostname);
  let addresses;
  if (literalFamily) addresses = [{ address: hostname, family: literalFamily }];
  else {
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch (error) { throw fail('WEB_DNS_FAILED', 'KL01 could not resolve that public web address.', 502, undefined, error); }
  }
  const unique = [];
  const seen = new Set();
  for (const item of addresses || []) {
    const address = String(item?.address || '');
    const family = Number(item?.family || net.isIP(address));
    if (!address || ![4, 6].includes(family) || seen.has(`${family}:${address}`)) continue;
    seen.add(`${family}:${address}`); unique.push({ address, family });
  }
  if (!unique.length) throw fail('WEB_DNS_EMPTY', 'That web address did not resolve to a usable public destination.', 502);
  if (unique.some(item => !isPublicAddress(item.address))) throw fail('WEB_DESTINATION_BLOCKED', 'KL01 blocked this address because it could reach this computer or a private network.', 403);
  return { url, port, hostname, addresses: orderValidatedAddresses(unique) };
}
