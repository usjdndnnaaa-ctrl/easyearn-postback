'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.statusCode = status;
  if (typeof res.setHeader === 'function') res.setHeader('content-type', contentType);
  if (typeof res.setHeader === 'function') res.setHeader('cache-control', 'no-store');
  const text = contentType.startsWith('text/') ? body : JSON.stringify(body);
  if (typeof res.end === 'function') return res.end(text);
  if (typeof res.send === 'function') return res.send(text);
  if (typeof res.json === 'function') return res.json(body);
}

function isPrivateAddress(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const version = net.isIP(host);
  if (version === 4) {
    const o = host.split('.').map(Number);
    return o[0] === 0 || o[0] === 10 || o[0] === 127 ||
      (o[0] === 169 && o[1] === 254) ||
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 168) || o[0] >= 224;
  }
  if (version === 6) return host === '::' || host === '::1' || host.startsWith('fc') ||
    host.startsWith('fd') || host.startsWith('fe80:') || host.startsWith('::ffff:127.');
  return false;
}

function getForwardUrl() {
  const raw = process.env.POSTBACK_FORWARD_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
        url.hash || isPrivateAddress(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function queryFromRequest(req) {
  const url = new URL(req.url || '/', `https://${req.headers?.host || 'vercel.invalid'}`);
  const query = Object.fromEntries(url.searchParams.entries());
  if (req.query && typeof req.query === 'object') {
    for (const [key, value] of Object.entries(req.query)) {
      if (value !== undefined) query[key] = Array.isArray(value) ? value[0] : value;
    }
  }
  return query;
}

function parseBody(req) {
  let body = req.body;
  if (body == null || body === '') return {};
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw Object.assign(new Error(), { status: 413 });
    if (String(req.headers?.['content-type'] || '').toLowerCase().includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(body).entries());
    }
    try { body = JSON.parse(body); } catch { throw Object.assign(new Error(), { status: 400 }); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error(), { status: 400 });
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BYTES) throw Object.assign(new Error(), { status: 413 });
  return body;
}

function cleanPayload(input) {
  if (Array.isArray(input)) return input.map(cleanPayload);
  if (!input || typeof input !== 'object') return input;
  const cleaned = {};
  for (const [key, value] of Object.entries(input)) {
    if (/^(?:.*token.*|health|.*secret.*|.*password.*|authorization)$/i.test(key)) continue;
    cleaned[key] = cleanPayload(value);
  }
  return cleaned;
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const provided = Buffer.from(candidate, 'utf8');
  const configured = Buffer.from(expected, 'utf8');
  return provided.length === configured.length && crypto.timingSafeEqual(provided, configured);
}

function timeoutMs() {
  const configured = Number(process.env.POSTBACK_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 100 && configured <= 30000 ? configured : DEFAULT_TIMEOUT_MS;
}

module.exports = async function postback(req, res) {
  const method = String(req.method || '').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    if (typeof res.setHeader === 'function') res.setHeader('allow', 'GET, POST');
    return send(res, 405, { error: 'method_not_allowed' });
  }

  let query;
  try { query = queryFromRequest(req); } catch { return send(res, 400, { error: 'invalid_request' }); }
  if (method === 'GET' && (Object.keys(query).length === 0 || (Object.keys(query).length === 1 && String(query.health) === '1'))) {
    return send(res, 200, {
      status: 'ok',
      authConfigured: Boolean(process.env.POSTBACK_SECRET),
      forwardingConfigured: Boolean(getForwardUrl()),
    });
  }

  let body;
  try { body = parseBody(req); } catch (error) {
    return send(res, error.status || 400, { error: error.status === 413 ? 'payload_too_large' : 'invalid_payload' });
  }
  let merged;
  try {
    merged = cleanPayload({ ...query, ...body });
    if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > MAX_BYTES) return send(res, 413, { error: 'payload_too_large' });
  } catch { return send(res, 400, { error: 'invalid_payload' }); }

  const expected = process.env.POSTBACK_SECRET;
  const headerToken = req.headers?.['x-postback-secret'];
  const candidate = typeof headerToken === 'string' && headerToken ? headerToken : query.token;
  const url = getForwardUrl();
  if (!expected || !url) return send(res, 503, { error: 'postback_not_configured' });
  if (!tokenMatches(candidate, expected)) return send(res, 401, { error: 'unauthorized' });

  const payload = { provider: merged.provider || merged.network || 'generic', metadata: merged };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  if (typeof timer.unref === 'function') timer.unref();
  const headers = { 'content-type': 'application/json', accept: '*/*' };
  if (process.env.POSTBACK_FORWARD_TOKEN) headers['x-postback-forward-token'] = process.env.POSTBACK_FORWARD_TOKEN;
  try {
    const response = await fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error' });
    if (!response.ok) return send(res, 502, { error: 'forward_failed' });
    return send(res, 200, 'OK', 'text/plain; charset=utf-8');
  } catch {
    return send(res, controller.signal.aborted ? 504 : 502,
      { error: controller.signal.aborted ? 'forward_timeout' : 'forward_failed' });
  } finally { clearTimeout(timer); }
};
