/**
 * Encrypted checkpoints — disaster recovery for a local-first org.
 *
 * A checkpoint is every org document (roster + base + distros) serialized
 * with `repo.export` and encrypted CLIENT-SIDE with AES-256-GCM under a key
 * derived from the admin's passphrase (PBKDF2-SHA-256, 310k iterations,
 * random salt). The ciphertext is safe to store anywhere — a USB stick, a
 * drive, or pinned to IPFS — because without the passphrase it's noise.
 * The passphrase never leaves the device and is never written anywhere.
 *
 * File layout (bytes):
 *   "MATCKPT1" ─ 8-byte magic
 *   u32 (LE)   ─ header length
 *   header     ─ UTF-8 JSON: { v, org, createdAt, kdf, iv, docs: [{key,len}] }
 *   ciphertext ─ AES-GCM over the concatenated doc binaries (docs[] order)
 *
 * Restoring imports the docs into a fresh repo. `repo.import` assigns NEW
 * document ids, so the restored roster's baseDocUrl/dataDomains pointers are
 * rewritten to the new urls — the restore is a recovered copy of the org,
 * and other devices rejoin it via a fresh roster link.
 */

import type { Repo } from "@automerge/automerge-repo";
import type { BamStore } from "./store.ts";
import type { BamDoc, DistrosDoc, RosterDoc } from "./schema.ts";
import { nowIso } from "./schema.ts";

const MAGIC = "MATCKPT1";
const KDF_ITERATIONS = 310_000;

export interface CheckpointHeader {
  v: 1;
  org: string;
  createdAt: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  iv: string;
  docs: Array<{ key: string; len: number }>;
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Serialize + encrypt every org doc under the passphrase. */
export async function createCheckpoint(
  store: BamStore,
  passphrase: string
): Promise<{ bytes: Uint8Array; header: CheckpointHeader }> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("Pick a passphrase of at least 8 characters — it IS the backup's lock.");
  }
  const docs: Array<{ key: string; bytes: Uint8Array }> = [];
  const put = async (key: string, url: string | undefined) => {
    if (!url) return;
    const bytes = await store.repo.export(url as never);
    if (bytes) docs.push({ key, bytes: new Uint8Array(bytes) });
  };
  await put("roster", store.roster.url);
  await put("base", store.base.url);
  await put("distros", store.distros?.url);

  let total = 0;
  for (const d of docs) total += d.bytes.length;
  const plain = new Uint8Array(total);
  let offset = 0;
  for (const d of docs) {
    plain.set(d.bytes, offset);
    offset += d.bytes.length;
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource)
  );

  const header: CheckpointHeader = {
    v: 1,
    org: store.base.doc()?.meta.org ?? "org",
    createdAt: nowIso(),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: b64encode(salt) },
    iv: b64encode(iv),
    docs: docs.map((d) => ({ key: d.key, len: d.bytes.length })),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const magic = new TextEncoder().encode(MAGIC);
  const out = new Uint8Array(magic.length + 4 + headerBytes.length + ciphertext.length);
  out.set(magic, 0);
  new DataView(out.buffer).setUint32(magic.length, headerBytes.length, true);
  out.set(headerBytes, magic.length + 4);
  out.set(ciphertext, magic.length + 4 + headerBytes.length);
  return { bytes: out, header };
}

/** Parse + decrypt a checkpoint file. Throws on bad magic or wrong passphrase. */
export async function decryptCheckpoint(
  bytes: Uint8Array,
  passphrase: string
): Promise<{ header: CheckpointHeader; docs: Array<{ key: string; bytes: Uint8Array }> }> {
  const magic = new TextDecoder().decode(bytes.slice(0, MAGIC.length));
  if (magic !== MAGIC) {
    throw new Error("That file isn't a checkpoint from this app (bad header).");
  }
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset + MAGIC.length, 4).getUint32(0, true);
  const headerStart = MAGIC.length + 4;
  const header = JSON.parse(
    new TextDecoder().decode(bytes.slice(headerStart, headerStart + headerLen))
  ) as CheckpointHeader;
  const ciphertext = bytes.slice(headerStart + headerLen);
  const key = await deriveKey(passphrase, b64decode(header.kdf.salt), header.kdf.iterations);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64decode(header.iv) as BufferSource },
        key,
        ciphertext as BufferSource
      )
    );
  } catch {
    throw new Error("Wrong passphrase (or a corrupted file) — nothing was decrypted.");
  }
  const docs: Array<{ key: string; bytes: Uint8Array }> = [];
  let offset = 0;
  for (const d of header.docs) {
    docs.push({ key: d.key, bytes: plain.slice(offset, offset + d.len) });
    offset += d.len;
  }
  return { header, docs };
}

/**
 * Read the documents out of a decrypted checkpoint.
 *
 * Imports them into `repo` only to decode the Automerge binaries; the caller
 * copies the contents into a fresh org rather than adopting these handles.
 * Restoring has to produce ENCRYPTED documents, and encryption is decided when
 * a document is created — an imported one can never be retrofitted.
 */
export function readCheckpointDocs(
  repo: Repo,
  docs: Array<{ key: string; bytes: Uint8Array }>
): { roster: RosterDoc; base: BamDoc; distros?: DistrosDoc } {
  const byKey = new Map(docs.map((d) => [d.key, d.bytes]));
  const rosterBytes = byKey.get("roster");
  const baseBytes = byKey.get("base");
  if (!rosterBytes || !baseBytes) {
    throw new Error("Checkpoint is missing the roster or base document.");
  }
  const roster = repo.import<RosterDoc>(rosterBytes as never).doc();
  const base = repo.import<BamDoc>(baseBytes as never).doc();
  const distrosBytes = byKey.get("distros");
  const distros = distrosBytes
    ? repo.import<DistrosDoc>(distrosBytes as never).doc()
    : undefined;
  if (!roster || !base) throw new Error("Checkpoint documents could not be read.");
  return { roster, base, ...(distros ? { distros } : {}) };
}

/** Automerge rejects live proxies and undefined; round-trip through JSON. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Copy a checkpoint's contents into a freshly created (encrypted) org.
 *
 * The restoring device is already this org's founding admin, so it keeps that
 * role; the backup's other members come across with their contact cards, which
 * is what lets `syncAccess` hand them their keys again when they reconnect.
 * Document pointers are NOT copied — they refer to the backup's documents,
 * while this org's are new and encrypted.
 */
export function restoreInto(
  store: BamStore,
  snapshot: { roster: RosterDoc; base: BamDoc; distros?: DistrosDoc }
): void {
  store.base.change((d) => {
    for (const [key, value] of Object.entries(snapshot.base)) {
      if (key === "meta") continue; // keeps this org's own identity
      (d as unknown as Record<string, unknown>)[key] = plain(value);
    }
    d.meta.org = snapshot.base.meta.org;
  });

  if (store.distros && snapshot.distros) {
    const from = snapshot.distros;
    store.distros.change((d) => {
      for (const [key, value] of Object.entries(from)) {
        if (key === "meta") continue;
        (d as unknown as Record<string, unknown>)[key] = plain(value);
      }
    });
  }

  store.roster.change((d) => {
    d.org = snapshot.roster.org;
    for (const [peerId, member] of Object.entries(snapshot.roster.members)) {
      if (peerId === store.peerId) continue; // we are the restoring admin
      d.members[peerId] = plain(member);
    }
    // Invites are bearer credentials tied to the old org; let admins reissue.
  });
}

/* IPFS pinning (optional): POST the ciphertext to a pinning service. The
 * credential stays on the admin's device (localStorage), never in the doc;
 * only the CID — which reveals nothing without the passphrase — is recorded
 * in the org's checkpoint history. */

export async function pinToIpfs(
  bytes: Uint8Array,
  opts: { pinataJwt: string; name: string }
): Promise<{ cid: string; gatewayUrl: string }> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
      type: "application/octet-stream",
    }),
    opts.name
  );
  form.append("pinataMetadata", JSON.stringify({ name: opts.name }));
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.pinataJwt}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinning failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const out = (await res.json()) as { IpfsHash?: string };
  if (!out.IpfsHash) throw new Error("Pinning service returned no CID.");
  return { cid: out.IpfsHash, gatewayUrl: `https://gateway.pinata.cloud/ipfs/${out.IpfsHash}` };
}

/** Fetch a checkpoint back from IPFS by CID via public gateways. */
export async function fetchFromIpfs(cid: string): Promise<Uint8Array> {
  const gateways = [
    `https://gateway.pinata.cloud/ipfs/${cid}`,
    `https://ipfs.io/ipfs/${cid}`,
    `https://cloudflare-ipfs.com/ipfs/${cid}`,
  ];
  let lastErr: unknown;
  for (const url of gateways) {
    try {
      const res = await fetch(url);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      lastErr = new Error(`${url} → ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not fetch that CID from public gateways (${lastErr instanceof Error ? lastErr.message : String(lastErr)}).`
  );
}
