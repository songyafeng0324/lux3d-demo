import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { parseTrustProxy } from '@aholo/domain';

test('TRUST_PROXY: unset means no proxy, trust-all is refused, addresses pass through', () => {
  for (const raw of [undefined, '', '  ', 'false', '0', 'off']) assert.equal(parseTrustProxy(raw), false);
  for (const raw of ['true', '1', '*', 'yes', '0.0.0.0/0', '::/0', 'loopback,0.0.0.0/0']) assert.throws(() => parseTrustProxy(raw), /not trust every hop/);
  for (const raw of ['loopback, nginx.local', 'abc', '...', '10.0.0.0/33', '::1/129', '10.0.0.1/8/1', '10.0.0.0/x']) assert.throws(() => parseTrustProxy(raw), /Invalid TRUST_PROXY/, raw);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy(' 127.0.0.1 , 10.0.0.0/8,::1 '), '127.0.0.1,10.0.0.0/8,::1');
});

async function ipOf(trustProxy, remoteAddress, forwarded) {
  const app = Fastify({ trustProxy });
  app.get('/ip', async request => ({ ip: request.ip }));
  const res = await app.inject({ url: '/ip', remoteAddress, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
  await app.close();
  return res.json().ip;
}

test('behind a trusted local Nginx each visitor keeps their own IP for the per-IP rate limits', async () => {
  const trust = parseTrustProxy('loopback');
  assert.equal(await ipOf(false, '127.0.0.1', '203.0.113.9'), '127.0.0.1', 'without the option every visitor looks like the proxy');
  assert.equal(await ipOf(trust, '127.0.0.1', '203.0.113.9'), '203.0.113.9');
  // Nginx appends the real peer; a forged entry further left is ignored.
  assert.equal(await ipOf(trust, '127.0.0.1', '198.51.100.1, 203.0.113.9'), '203.0.113.9');
  // A caller reaching the API directly cannot pick its IP through the header.
  assert.equal(await ipOf(trust, '198.51.100.7', '203.0.113.9'), '198.51.100.7');
});
