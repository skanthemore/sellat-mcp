import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SellatApiError, createClient } from 'sellat-cli';
import { checkAnchorOnChain, verifyProofOffline } from 'sellat-verify';
import { cleanName, defaultDownloadDir, expandPath, freePath, mimeTypeFor, requireFile, sha256File } from './files.mjs';
import { proofJsonFromZip } from './zip.mjs';

export const VERSION = '0.1.0';

const KEYS_URL = 'https://sellat.app/dashboard#api-keys';

const INSTRUCTIONS = `SELLAT creates independently verifiable proof that an exact file existed at a given time.

- Files are hashed on this machine. Only the SHA-256 goes to SELLAT; the file itself never leaves the computer.
- A new proof is anchored on Polygon in a Merkle batch: within minutes on the Pro account, at the end of a fixed four-hour UTC slot on the free account (the proof's "anchoring" field says which). Bitcoin (OpenTimestamps) confirms hours later. Do not promise an on-chain transaction in seconds; use sellat_status to follow it.
- The qualified seal (FNMT-RCM, eIDAS, RFC 3161) is immediate, but it spends one seal from the account. Only request it when the user has explicitly asked for it in this conversation.
- Payments never happen here. When the account has no seals left the tools answer with a link to buy them on the web; give the user that link and wait for them to say they bought before trying again.
- Verification (sellat_verify) is done locally against the public blockchain: it does not trust SELLAT's database.
- A proof shows that the bytes existed at that time. It does not prove authorship or ownership by itself; do not claim more than that.`;

/** A tool result: one line a person can read, then the data. */
function ok(summary, data) {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: 'text', text }] };
}

function fail(message, data) {
  return { ...ok(message, data), isError: true };
}

function describeError(error) {
  if (error instanceof SellatApiError) {
    if (error.status === 402) {
      return fail(
        `${error.message}\nPayment happens on the SELLAT website, never through this tool. Give the user the link above; try again only after they say they have bought seals.`,
        error.details
      );
    }
    if (error.status === 401) {
      return fail(`The SELLAT API key was rejected (invalid or revoked). Create a new one at ${KEYS_URL} and set SELLAT_API_TOKEN in the MCP client's configuration.`);
    }
    if (error.status === 429) {
      return fail(error.message, error.details);
    }
    return fail(`SELLAT API error${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`, error.details);
  }
  return fail(String(error?.message ?? error));
}

/** Plain-language timing for a proof, from the fields the API returns. */
function anchoringLine(proof) {
  const polygon = (proof.anchors ?? []).find((a) => a.tx_hash);
  if (polygon) {
    return `Anchored on ${polygon.network} at ${polygon.block_timestamp} (tx ${polygon.tx_hash}).`;
  }
  if (proof.state === 'failed') return 'Anchoring failed; contact SELLAT support.';
  if (proof.anchoring?.policy === 'scheduled' && proof.anchoring.batch_closes_after) {
    return `Not on-chain yet: it goes into the batch that closes at ${proof.anchoring.batch_closes_after} (free account, every four hours UTC), then on Polygon.`;
  }
  return 'Not on-chain yet: its batch is anchored on Polygon within minutes.';
}

function bitcoinLine(proof) {
  if (proof.bitcoin?.state === 'confirmed') return `Bitcoin: confirmed in block ${proof.bitcoin.block_height}.`;
  if (proof.bitcoin?.state === 'pending') return 'Bitcoin: pending (OpenTimestamps confirms some hours after the Polygon anchor).';
  return null;
}

function sealLine(proof) {
  if (proof.qualified?.state === 'issued') {
    return `Qualified seal: issued by ${proof.qualified.authority} at ${proof.qualified.time}.`;
  }
  if (proof.qualified?.state === 'pending') return 'Qualified seal: requested, pending.';
  return null;
}

function proofSummary(proof, lead) {
  return [lead, anchoringLine(proof), bitcoinLine(proof), sealLine(proof), proof.urls?.certificate ? `Certificate: ${proof.urls.certificate}` : null]
    .filter(Boolean)
    .join('\n');
}

/**
 * The SELLAT MCP server. `env` and `fetchImpl` are injectable so tests run
 * against a fake API; the binary passes the real ones.
 */
export function createSellatServer({ env = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = (env.SELLAT_API_URL ?? 'https://sellat.app').replace(/\/+$/, '');
  const token = env.SELLAT_API_TOKEN ?? env.SELLAT_API_KEY;

  function client() {
    if (!token) {
      throw new Error(
        `No SELLAT API key configured. Create one at ${KEYS_URL} (free account) and set SELLAT_API_TOKEN in the MCP client's configuration for sellat-mcp. Hashing and verifying work without a key.`
      );
    }
    return createClient({ token, baseUrl, fetchImpl });
  }

  /** Runs a tool body and turns every error into a result the model can read. */
  const guarded = (body) => async (args) => {
    try {
      return await body(args);
    } catch (error) {
      return describeError(error);
    }
  };

  const server = new McpServer({ name: 'sellat', version: VERSION }, { instructions: INSTRUCTIONS });

  const proofId = z.string().min(1).describe('The SELLAT proof id (returned by sellat_stamp or sellat_list).');

  server.registerTool(
    'sellat_hash',
    {
      title: 'Fingerprint a file',
      description:
        'Compute the SHA-256 fingerprint of a local file. Runs entirely on this machine: nothing is sent anywhere. Useful to compare two files or to check a fingerprint someone gave you.',
      inputSchema: { path: z.string().min(1).describe('Absolute path of the file (~ is expanded).') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ path }) => {
      const file = requireFile(path);
      const sha256 = await sha256File(file.path);
      return ok(`SHA-256 of ${file.name}: ${sha256}`, { path: file.path, sha256, size_bytes: file.size });
    })
  );

  server.registerTool(
    'sellat_stamp',
    {
      title: 'Protect a file',
      description:
        'Create a SELLAT proof of existence for a local file. The file is hashed on this machine and only its SHA-256 (plus the name and size) is sent; the file itself never leaves the computer. Stamping the same file again returns the existing proof (the earlier date is the stronger one). Set qualified=true only when the user explicitly asked for the qualified eIDAS seal: it spends one seal from the account.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute path of the file to protect (~ is expanded).'),
        name: z.string().max(200).optional().describe('Name shown on the certificate. Defaults to the file name.'),
        qualified: z
          .boolean()
          .optional()
          .describe('Also issue the FNMT-RCM qualified timestamp (eIDAS). Spends one seal. Only if the user asked for it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ path, name, qualified }) => {
      const api = client();
      const file = requireFile(path);
      const hash = await sha256File(file.path);
      // Keyed on the bytes: a retried call, or the same file twice, is one proof.
      let proof = await api.create({
        hash,
        name: cleanName(name ?? file.name),
        size: file.size,
        mimeType: mimeTypeFor(file.path),
        idempotencyKey: `sellat-mcp:${hash}`,
      });
      if (qualified && !proof.qualified) {
        try {
          const sealed = await api.seal(proof.id);
          proof = { ...proof, qualified: sealed.qualified };
        } catch (error) {
          // The proof exists either way; say so before the seal's error.
          const result = describeError(error);
          result.content[0].text = `Protected ${file.name} as proof ${proof.id}, but the qualified seal was not issued.\n${result.content[0].text}`;
          return result;
        }
      }
      const lead = proof.created === false
        ? `${file.name} was already protected: proof ${proof.id}, received ${proof.received_at}.`
        : `Protected ${file.name}: proof ${proof.id}, received ${proof.received_at}.`;
      return ok(proofSummary(proof, lead), proof);
    })
  );

  server.registerTool(
    'sellat_status',
    {
      title: 'Proof status',
      description:
        'The current state of a proof: whether its batch is anchored on Polygon, the Bitcoin confirmation, the qualified seal and its URLs.',
      inputSchema: { proof_id: proofId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ proof_id }) => {
      const proof = await client().get(proof_id);
      return ok(proofSummary(proof, `Proof ${proof.id} (${proof.name}): ${proof.state}.`), proof);
    })
  );

  server.registerTool(
    'sellat_list',
    {
      title: 'List proofs',
      description: "The account's proofs, newest first, one page at a time.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Page size, 1–100 (default 25).'),
        cursor: z.string().optional().describe('next_cursor from the previous page.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ limit, cursor }) => {
      const page = await client().list({ limit, cursor });
      const lines = (page.data ?? []).map((p) => `- ${p.id}  ${p.received_at}  ${p.state}  ${p.name ?? ''}`);
      return ok(lines.length ? lines.join('\n') : 'No proofs on this account yet.', page);
    })
  );

  server.registerTool(
    'sellat_seal',
    {
      title: 'Add the qualified seal',
      description:
        'Issue the FNMT-RCM qualified electronic timestamp (eIDAS, RFC 3161) for an existing proof. Spends one seal from the account: call it only when the user explicitly asked for it. With no seals left it returns the link to buy them on the web. Calling it again on a sealed proof returns the existing seal without spending another.',
      inputSchema: { proof_id: proofId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ proof_id }) => {
      const result = await client().seal(proof_id);
      const q = result.qualified;
      const summary =
        q?.state === 'issued'
          ? `${result.created ? 'Qualified seal issued' : 'Already sealed'}: ${q.authority}, ${q.time}. Seals left: ${result.seals_remaining}.`
          : `Qualified seal requested (${q?.state ?? 'pending'}). Seals left: ${result.seals_remaining ?? '?'}.`;
      return ok(summary, result);
    })
  );

  server.registerTool(
    'sellat_account',
    {
      title: 'Account',
      description:
        "The account's plan, qualified seals remaining, custody usage and today's proof budget, with the link to buy seals.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => {
      const account = await client().account();
      const seals = account.seals ?? {};
      const proofs = account.proofs ?? {};
      return ok(
        [
          `Plan: ${account.plan_name ?? account.plan ?? 'unknown'}.`,
          `Qualified seals left: ${seals.remaining ?? '?'}${seals.price_eur ? ` (more at ${seals.price_eur} € each: ${seals.buy_url})` : ''}.`,
          `Proofs today: ${proofs.used_today ?? '?'} of ${proofs.daily_limit ?? '?'}.`,
        ].join('\n'),
        account
      );
    })
  );

  const downloads = {
    certificate: { call: (api, id, lang) => api.certificate(id, { lang }), fallback: (id) => `sellat-${id}.pdf` },
    evidence: { call: (api, id, lang) => api.evidence(id, { lang }), fallback: (id) => `sellat-${id}-evidence.zip` },
    tsr: { call: (api, id) => api.tsr(id), fallback: (id) => `sellat-${id}.tsr` },
  };

  server.registerTool(
    'sellat_download',
    {
      title: 'Download certificate or evidence',
      description:
        'Save a proof document to this computer: the PDF certificate, the evidence package (ZIP with proof.json, the OpenTimestamps file and instructions to verify without SELLAT) or the RFC 3161 token of the qualified seal (.tsr). Never overwrites an existing file.',
      inputSchema: {
        proof_id: proofId,
        kind: z.enum(['certificate', 'evidence', 'tsr']).describe('certificate = PDF, evidence = ZIP package, tsr = qualified seal token.'),
        lang: z.enum(['es', 'en', 'de', 'fr']).optional().describe("Language of the certificate or package; use the user's language. Default en."),
        directory: z.string().optional().describe('Folder to save into. Default: SELLAT_DOWNLOAD_DIR, else ~/Downloads.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async ({ proof_id, kind, lang = 'en', directory }) => {
      const download = downloads[kind];
      const file = await download.call(client(), proof_id, lang);
      const name = cleanName(basename(file.fileName ?? download.fallback(proof_id)));
      const target = freePath(directory ? expandPath(directory) : defaultDownloadDir(env), name);
      await writeFile(target, file.bytes, { flag: 'wx' });
      return ok(`Saved ${target} (${file.bytes.length} bytes).`, { path: target, size_bytes: file.bytes.length, content_type: file.contentType });
    })
  );

  server.registerTool(
    'sellat_verify',
    {
      title: 'Verify a proof',
      description:
        "Check that a file matches a SELLAT proof and that the proof is really anchored on the blockchain, without trusting SELLAT: the file is hashed locally, the Merkle path is recomputed, and a public blockchain node is asked whether the anchoring transaction carries the root. Give the proof as a proof.json or an evidence package (.zip), or as a proof id (its public proof.json is then fetched from SELLAT — the checks themselves stay independent). Does not check the qualified seal's .tsr. Needs no API key.",
      inputSchema: {
        file_path: z.string().min(1).describe('Absolute path of the file to check.'),
        proof_path: z.string().optional().describe('Path to proof.json or to an evidence package (.zip).'),
        proof_id: z.string().optional().describe('A proof id, when there is no proof file at hand.'),
        offline: z.boolean().optional().describe('Skip the blockchain check (math only). Default false.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ file_path, proof_path, proof_id, offline = false }) => {
      if (!proof_path && !proof_id) {
        return fail('Give the proof: proof_path (proof.json or the evidence .zip) or proof_id.');
      }
      const file = requireFile(file_path);
      const fileHash = await sha256File(file.path);

      let proof;
      if (proof_path) {
        const source = requireFile(proof_path);
        const bytes = await readFile(source.path);
        if (bytes.readUInt32LE(0) === 0x04034b50) {
          proof = proofJsonFromZip(bytes);
          if (!proof) {
            return fail('This evidence package has no proof.json yet: it was downloaded before its batch was anchored. Download it again (sellat_download kind=evidence) or pass proof_id.');
          }
        } else {
          proof = JSON.parse(bytes.toString('utf8'));
        }
      } else {
        const response = await fetchImpl(`${baseUrl}/api/v2/proof/${encodeURIComponent(proof_id)}.json`);
        if (response.status === 202) {
          return ok(`Proof ${proof_id} exists but its batch is not anchored yet, so there is nothing on-chain to verify. Try again later (Retry-After: ${response.headers.get('retry-after') ?? '?'} s).`);
        }
        if (!response.ok) {
          return fail(`Could not fetch the public proof ${proof_id} (HTTP ${response.status}).`);
        }
        proof = await response.json();
      }

      const result = verifyProofOffline(proof, fileHash);
      const checks = [...result.checks];
      if (!offline) {
        for (const [i, anchor] of (proof.anchors ?? []).entries()) {
          try {
            const onChain = await checkAnchorOnChain(anchor, { fetchImpl });
            checks.push({ name: `anchor[${i}] on-chain`, ok: onChain.ok, detail: onChain.detail });
          } catch (error) {
            checks.push({ name: `anchor[${i}] on-chain`, ok: false, detail: String(error?.message ?? error) });
          }
        }
      }

      const verified = checks.every((c) => c.ok);
      const matches = fileHash === proof?.content?.hash;
      const proofSound = checks.every((c) => c.ok || c.name === 'file matches proof');
      const when = proof.anchors?.[0]?.block_timestamp;
      const summary = verified
        ? `VERIFIED${offline ? ' (offline: the blockchain was not consulted)' : ''}: this exact file existed no later than ${when ?? 'the anchored time'}.`
        : !matches
          ? `NOT VERIFIED: this file is not the one the proof covers (its SHA-256 differs: even one changed byte changes it).${proofSound ? ` The proof itself is sound and anchored at ${when ?? 'its anchored time'}, for other bytes.` : ''}`
          : 'NOT VERIFIED: at least one check failed (see below). If only the on-chain check failed, the public node may be unreachable; retry later.';
      const lines = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
      return ok(`${summary}\n\n${lines.join('\n')}`, { verified, file_sha256: fileHash, proof_id: proof.proof_id, anchored_at: when ?? null });
    })
  );

  return server;
}
