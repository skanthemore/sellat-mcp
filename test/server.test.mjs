import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSellatServer } from '../src/server.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const EXAMPLE_FILE = join(FIXTURES, 'example.txt');
const EXAMPLE_PROOF = join(FIXTURES, 'example.proof.json');
const EXAMPLE_HASH = '2ad295bdf52f661acda66158a7b20fc7c982e190b2645117ea6a77583703e291';

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fake SELLAT API (and Polygon node): `routes` maps "METHOD path" to a handler. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method ?? 'GET'} ${pathname}`;
    calls.push({ key, search, headers: init.headers ?? {}, body: init.body });
    const handler = routes[key];
    if (!handler) return json(404, { error: { code: 'not_found', message: `no route ${key}` } });
    return handler({ url, init });
  };
  return { impl, calls };
}

async function connect({ env = { SELLAT_API_TOKEN: 'sellat_test' }, routes = {} } = {}) {
  const fetch = fakeFetch(routes);
  const server = createSellatServer({ env: { SELLAT_API_URL: 'https://sellat.test', ...env }, fetchImpl: fetch.impl });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, text: result.content.map((c) => c.text).join('\n') };
  };
  return { client, call, calls: fetch.calls };
}

const PROOF = {
  id: 'p-1',
  created: true,
  hash: EXAMPLE_HASH,
  name: 'example.txt',
  state: 'queued',
  received_at: '2026-10-05T10:00:00.000Z',
  anchoring: { policy: 'scheduled', batch_closes_after: '2026-10-05T12:00:00.000Z' },
  anchors: [],
  bitcoin: { state: 'pending', block_height: null },
  qualified: null,
  urls: { certificate: 'https://sellat.test/certificate/abc' },
};

test('lists the nine tools, with instructions about payments', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['sellat_account', 'sellat_download', 'sellat_find', 'sellat_hash', 'sellat_list', 'sellat_seal', 'sellat_stamp', 'sellat_status', 'sellat_verify']
  );
  assert.match(client.getInstructions(), /Payments never happen here/);
});

test('sellat_hash works offline and without a key', async () => {
  const { call, calls } = await connect({ env: {} });
  const result = await call('sellat_hash', { path: EXAMPLE_FILE });
  assert.equal(result.isError, undefined);
  assert.match(result.text, new RegExp(EXAMPLE_HASH));
  assert.equal(calls.length, 0);
});

test('sellat_stamp sends the hash, never the file, keyed for idempotency', async () => {
  const { call, calls } = await connect({ routes: { 'POST /api/v2/proofs': () => json(201, PROOF) } });
  const result = await call('sellat_stamp', { path: EXAMPLE_FILE });
  assert.equal(result.isError, undefined);
  assert.match(result.text, /Protected example\.txt: proof p-1/);
  assert.match(result.text, /batch that closes at 2026-10-05T12:00:00\.000Z/);

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(body).sort(), ['hash', 'mime_type', 'name', 'size']);
  assert.equal(body.hash, EXAMPLE_HASH);
  assert.equal(calls[0].headers['Idempotency-Key'], `sellat-mcp:${EXAMPLE_HASH}`);
  assert.equal(calls[0].headers.Authorization, 'Bearer sellat_test');
});

test('sellat_stamp without a key explains where to get one', async () => {
  const { call } = await connect({ env: {} });
  const result = await call('sellat_stamp', { path: EXAMPLE_FILE });
  assert.equal(result.isError, true);
  assert.match(result.text, /dashboard#api-keys/);
});

test('sellat_stamp qualified with no seals left keeps the proof and gives the buy link', async () => {
  const { call } = await connect({
    routes: {
      'POST /api/v2/proofs': () => json(201, PROOF),
      'POST /api/v2/proofs/p-1/qualified': () =>
        json(402, { error: { code: 'payment_required', message: 'No qualified seals left on this account.', seals_remaining: 0, buy_url: 'https://sellat.test/precios' } }),
    },
  });
  const result = await call('sellat_stamp', { path: EXAMPLE_FILE, qualified: true });
  assert.equal(result.isError, true);
  assert.match(result.text, /Protected example\.txt as proof p-1, but the qualified seal was not issued/);
  assert.match(result.text, /https:\/\/sellat\.test\/precios/);
  assert.match(result.text, /never through this tool/);
});

test('sellat_seal reports the issued seal', async () => {
  const { call } = await connect({
    routes: {
      'POST /api/v2/proofs/p-1/qualified': () =>
        json(200, { proof_id: 'p-1', created: true, qualified: { state: 'issued', authority: 'FNMT-RCM', time: '2026-10-05T10:00:01Z' }, seals_remaining: 2 }),
    },
  });
  const result = await call('sellat_seal', { proof_id: 'p-1' });
  assert.match(result.text, /Qualified seal issued: FNMT-RCM, 2026-10-05T10:00:01Z\. Seals left: 2\./);
});

test('sellat_download saves without overwriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sellat-mcp-'));
  const pdf = () =>
    new Response(Buffer.from('%PDF-1.7 test'), {
      headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="../../evil.pdf"' },
    });
  const { call, calls } = await connect({ routes: { 'GET /api/v2/proofs/p-1/certificate.pdf': pdf } });

  const first = await call('sellat_download', { proof_id: 'p-1', kind: 'certificate', lang: 'es', directory: dir });
  const second = await call('sellat_download', { proof_id: 'p-1', kind: 'certificate', lang: 'es', directory: dir });
  assert.match(first.text, new RegExp(`Saved ${join(dir, 'evil.pdf')}`));
  assert.match(second.text, /evil \(2\)\.pdf/);
  assert.equal(await readFile(join(dir, 'evil.pdf'), 'utf8'), '%PDF-1.7 test');
  assert.equal(calls[0].search, '?lang=es');
});

/** The JSON a tool appends after its summary. */
const data = (text) => JSON.parse(text.slice(text.lastIndexOf('\n\n{') + 2));

/** The example proof's Polygon transaction and block, as a node would return them. */
async function polygonNode() {
  const proof = JSON.parse(await readFile(EXAMPLE_PROOF, 'utf8'));
  const anchor = proof.anchors[0];
  const blockNumber = '0x' + anchor.block_number.toString(16);
  const results = {
    eth_getTransactionByHash: {
      hash: anchor.tx_hash,
      input: '0x' + Buffer.from(anchor.payload, 'utf8').toString('hex'),
      blockNumber,
      from: '0xsellat',
    },
    // 2026-08-10T22:30:04Z, the block's own time.
    eth_getBlockByNumber: { number: blockNumber, timestamp: '0x' + (1786401004).toString(16), transactions: [] },
  };
  return ({ init }) => json(200, { jsonrpc: '2.0', id: 1, result: results[JSON.parse(init.body).method] ?? null });
}

test('sellat_verify: proof.json, checked on-chain', async () => {
  const { call } = await connect({ env: {}, routes: { 'POST /': await polygonNode() } });
  const result = await call('sellat_verify', { file_path: EXAMPLE_FILE, proof_path: EXAMPLE_PROOF });
  assert.equal(result.isError, undefined);
  assert.match(result.text, /^VERIFIED: this exact file existed no later than 2026-08-10T22:30:04\.000Z/);
  assert.match(result.text, /✓ anchor\[0\] on-chain/);
  assert.equal(data(result.text).anchored_at, '2026-08-10T22:30:04.000Z');
});

// Security audit 2026-10-06, F01: a real proof with only its date edited.
test('sellat_verify: a proof whose date was edited is not verified, and the edited date is not repeated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sellat-mcp-'));
  const edited = JSON.parse(await readFile(EXAMPLE_PROOF, 'utf8'));
  edited.anchors[0].block_timestamp = '1970-01-01T00:00:00Z';
  const proofPath = join(dir, 'edited.proof.json');
  await writeFile(proofPath, JSON.stringify(edited));
  const { call } = await connect({ env: {}, routes: { 'POST /': await polygonNode() } });
  const result = await call('sellat_verify', { file_path: EXAMPLE_FILE, proof_path: proofPath });
  assert.match(result.text, /^NOT VERIFIED/);
  assert.match(result.text, /✗ anchor\[0\] on-chain: block \d+ is from 2026-08-10T22:30:04\.000Z, proof says 1970/);
  assert.equal(data(result.text).verified, false);
  assert.equal(data(result.text).anchored_at, null);
});

test('sellat_verify: offline proves no date', async () => {
  const { call } = await connect({ env: {} });
  const result = await call('sellat_verify', { file_path: EXAMPLE_FILE, proof_path: EXAMPLE_PROOF, offline: true });
  assert.match(result.text, /^CONSISTENT \(offline\)/);
  assert.doesNotMatch(result.text.split('\n')[0], /2026/);
  assert.equal(data(result.text).verified, false);
  assert.equal(data(result.text).consistent, true);
  assert.equal(data(result.text).anchored_at, null);
});

test('sellat_verify: a different file is not verified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sellat-mcp-'));
  const other = join(dir, 'other.txt');
  await writeFile(other, 'not the same bytes');
  const { call } = await connect({ env: {} });
  const result = await call('sellat_verify', { file_path: other, proof_path: EXAMPLE_PROOF, offline: true });
  assert.match(result.text, /^NOT VERIFIED: this file is not the one the proof covers/);
});

/** A ZIP with one deflated entry, as an evidence package carries proof.json. */
function zipWith(name, content) {
  const data = deflateRawSync(content);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBytes.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]);
}

test('sellat_verify: reads proof.json out of an evidence package', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sellat-mcp-'));
  const zip = join(dir, 'evidence.zip');
  await writeFile(zip, zipWith('proof.json', await readFile(EXAMPLE_PROOF)));
  const { call } = await connect({ env: {} });
  const result = await call('sellat_verify', { file_path: EXAMPLE_FILE, proof_path: zip, offline: true });
  assert.match(result.text, /^CONSISTENT \(offline\)/);
});

test('sellat_verify: by proof id, before the batch is anchored', async () => {
  const { call } = await connect({
    env: {},
    routes: { 'GET /api/v2/proof/p-1.json': () => json(202, { state: 'queued' }, { 'retry-after': '60' }) },
  });
  const result = await call('sellat_verify', { file_path: EXAMPLE_FILE, proof_id: 'p-1' });
  assert.match(result.text, /not anchored yet/);
});

test('sellat_find returns paths the other tools can use, without a key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sellat-mcp-'));
  await writeFile(join(dir, 'Factura Octubre.pdf'), 'x');
  const { call, calls } = await connect({ env: {} });
  const result = await call('sellat_find', { query: 'factura', folder: dir });
  assert.match(result.text, new RegExp(`- ${join(dir, 'Factura Octubre.pdf')}`));
  const none = await call('sellat_find', { query: 'nomina', folder: dir });
  assert.match(none.text, /No file matching "nomina"/);
  assert.equal(calls.length, 0);
});

test('an unexpanded ${user_config…} placeholder counts as no key', async () => {
  const { call } = await connect({ env: { SELLAT_API_TOKEN: '${user_config.api_token}' } });
  const result = await call('sellat_account');
  assert.match(result.text, /No SELLAT API key configured/);
});
