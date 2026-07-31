/**
 * Keyhive: cryptographic access control and content encryption.
 *
 * Without this, access control is policy-only — every compliant peer refuses
 * unauthorized fetches, but the relay carries plaintext and a rule-ignoring
 * peer can read it. Keyhive encrypts document content per-member, so a relay
 * stores ciphertext it cannot read and a revoked device cannot decrypt
 * anything written after its revocation.
 *
 * The bridge (@automerge/automerge-repo-keyhive) takes over Repo construction:
 * it supplies the signer, peer id, id factory and blob interceptor, and we
 * keep passing our own `subductionPolicy` so the roster stays a second,
 * independent layer of enforcement.
 *
 * THE RELAY MUST RUN IN KEYHIVE MODE. A `--auth open` subduction server drops
 * inbound keyhive frames silently — no error, no timeout — and serves stored
 * documents to anyone. `relaySpeaksKeyhive` below is the only way to tell.
 */

import {
  Access,
  ContactCard,
  DocumentId,
  initializeAutomergeRepoKeyhive,
  isUnprotectedDoc,
  setKeyhiveLogLevel,
  type AutomergeRepoKeyhive,
} from "@automerge/automerge-repo-keyhive";
import { Repo, initSubduction, parseAutomergeUrl } from "@automerge/automerge-repo";
import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import type { SubductionPolicyLike } from "./roster.ts";

/**
 * Keyhive-mode sync server. NOT the same host as the plain-sync default in
 * store.ts: that one runs `--auth open`, which per the server's own docs means
 * "allow-all storage policy with keyhive entirely absent … inbound keyhive
 * messages are dropped" — it can neither carry keyhive traffic nor keep a
 * stranger from reading whatever it holds.
 */
export const KEYHIVE_SYNC_ENDPOINT = "wss://keyhive.sync.automerge.org";

/** Matches `SyncServerSelection` in the bridge: a named identity or an explicit one. */
export type KeyhiveSyncServer =
  | "keyhive"
  | "subduction"
  | { contactCardJson: string; peerId: string };

export interface OpenKeyhiveRepoOptions {
  /** Keyhive's own storage (identity keypair, archives, ops, leaf secrets). */
  storage: StorageAdapterInterface;
  /**
   * Storage for the documents themselves; defaults to `storage`.
   *
   * Do not leave this unset expecting documents to land in `storage` anyway —
   * they are separate adapters, and a Repo built without one keeps documents
   * in memory only, so everything vanishes on reload while keyhive's own state
   * survives. Splitting them is only useful if you want the two in different
   * places.
   */
  docStorage?: StorageAdapterInterface;
  endpoints: string[];
  /** Kept as belt-and-braces authorization alongside keyhive's crypto. */
  subductionPolicy?: SubductionPolicyLike;
  /**
   * Service label for this client. The bridge appends its own random
   * per-instance component, so sibling tabs never collide on peer id — do not
   * add a nonce here.
   */
  peerIdSuffix?: string;
  syncServer?: KeyhiveSyncServer;
}

export interface KeyhiveStore {
  hive: AutomergeRepoKeyhive;
  repo: Repo;
  /**
   * This device's subduction peer id — what the roster keys members by and
   * what policy hooks compare against. Derived from the keypair keyhive
   * persists in `storage`, so it is stable across reloads, and distinct from
   * `hive.peerId` (which carries a per-instance nonce).
   */
  peerId: string;
}

export async function openKeyhiveRepo(opts: OpenKeyhiveRepoOptions): Promise<KeyhiveStore> {
  setKeyhiveLogLevel("warn");
  await initSubduction();
  const { hive, repo } = await initializeAutomergeRepoKeyhive({
    createRepo: (config) => new Repo(config),
    storage: opts.storage,
    peerIdSuffix: opts.peerIdSuffix ?? "mutualaid",
    syncServer: (opts.syncServer ?? "keyhive") as never,
    repo: {
      storage: opts.docStorage ?? opts.storage,
      subductionWebsocketEndpoints: opts.endpoints,
      // Cast only this field: the policy shape is structural and the bridge's
      // RepoConfig types it as subduction's own Policy class. Casting the
      // whole object instead would stop TypeScript checking the keys above.
      ...(opts.subductionPolicy
        ? { subductionPolicy: opts.subductionPolicy as never }
        : {}),
    },
  });
  const signer = await hive.constructSubductionSigner();
  return { hive, repo, peerId: signer.peerId().toString() };
}

/** Resolve the keyhive document behind an automerge URL. */
async function keyhiveDoc(hive: AutomergeRepoKeyhive, docUrl: string): Promise<unknown> {
  const { binaryDocumentId } = parseAutomergeUrl(docUrl as never);
  return hive.keyhive.getDocument(new DocumentId(binaryDocumentId) as never);
}

/**
 * Is this document keyhive-protected? Only documents created through the
 * bridge's id factory (`repo.create2`) are; `repo.create` produces a plain
 * 16-byte id with no keyhive state, and every membership call on one throws.
 * Existing documents cannot be upgraded in place — they must be recreated.
 */
export function isProtected(docUrl: string): boolean {
  return !isUnprotectedDoc(docUrl as never);
}

/** This device's contact card, for handing to whoever will grant us access. */
export function myContactCard(hive: AutomergeRepoKeyhive): string {
  return hive.active.contactCard.toJson();
}

/**
 * Ingest someone else's contact card.
 *
 * Cards must cross BOTH ways during onboarding: a delegation whose issuer the
 * receiver has never seen stays unverifiable, and the grant silently never
 * takes effect (the joiner's access just resolves to null).
 */
export async function receiveContactCard(
  hive: AutomergeRepoKeyhive,
  cardJson: string
): Promise<void> {
  await hive.receiveContactCard(ContactCard.fromJson(cardJson));
}

/**
 * Access levels, ordered. `relay` is store-and-forward only — enough to carry
 * ciphertext, never enough to read it — and is what a sync server holds.
 */
export type KeyhiveRole = "admin" | "edit" | "read" | "relay";

const accessFor = (role: KeyhiveRole) =>
  role === "admin"
    ? Access.admin()
    : role === "read"
      ? Access.read()
      : role === "relay"
        ? Access.relay()
        : Access.edit();

/**
 * Normalize keyhive's `Access` to our lowercase `KeyhiveRole`.
 *
 * The WASM type renders capitalized ("Admin"), which does not match the values
 * callers pass in, so comparing a returned role against a granted one would
 * quietly always be false.
 */
function roleOf(access: { toString(): string } | undefined | null): KeyhiveRole | null {
  const raw = access?.toString?.().toLowerCase();
  return raw === "admin" || raw === "edit" || raw === "read" || raw === "relay" ? raw : null;
}

/**
 * Let the sync server relay this document. The server holds `relay` access:
 * enough to store and forward, never enough to decrypt.
 */
export async function shareWithRelay(hive: AutomergeRepoKeyhive, docUrl: string): Promise<void> {
  await hive.addSyncServerRelayToDoc(docUrl as never);
}

/**
 * Grant a device access to a document, given the contact card it published.
 *
 * Note the caller must tolerate a short window afterwards: the bridge rotates
 * the document key on a ~2s debounce, and writes issued before that lands are
 * dropped by the blob interceptor rather than encrypted.
 */
export async function grantAccess(
  hive: AutomergeRepoKeyhive,
  docUrl: string,
  cardJson: string,
  role: KeyhiveRole = "edit"
): Promise<void> {
  await hive.addMemberToDoc(docUrl as never, ContactCard.fromJson(cardJson), accessFor(role));
}

/**
 * Revoke a device's access, then rotate the document key so subsequent writes
 * are encrypted under one the revoked device cannot derive.
 *
 * The rotation is not optional. `addMemberToDoc` triggers it via the bridge's
 * membership nudge; `revokeMemberFromDoc` does not, so without this every
 * later write to the document fails to encrypt ("transformOutgoing returned
 * null") and is silently dropped before it reaches storage or the network.
 * Verified against @automerge/automerge-repo-keyhive@0.4.0-alpha.sub.4.
 */
export async function revokeAccess(
  hive: AutomergeRepoKeyhive,
  repo: Repo,
  docUrl: string,
  memberId: string
): Promise<void> {
  await hive.revokeMemberFromDoc(docUrl as never, memberId);
  const doc = await keyhiveDoc(hive, docUrl);
  if (doc) {
    const leafSecret = await hive.keyhive.forcePcsUpdate(doc as never);
    if (leafSecret) await hive.keyhiveStorage.saveLeafSecret(leafSecret);
  }
  repo.shareConfigChanged();
}

/** Who can reach a document, and at what level. */
export async function listAccess(
  hive: AutomergeRepoKeyhive,
  docUrl: string
): Promise<{ id: string; role: KeyhiveRole | null; isSelf: boolean; isSyncServer: boolean }[]> {
  const members = await hive.listMembers(docUrl as never);
  return members.map((m) => ({
    id: m.id,
    role: roleOf(m.access),
    isSelf: m.isSelf,
    isSyncServer: m.isSyncServer,
  }));
}

/** This device's access to a document, or null if it has none. */
export async function myAccess(
  hive: AutomergeRepoKeyhive,
  docUrl: string
): Promise<KeyhiveRole | null> {
  return roleOf(await hive.bestAccessForDoc(hive.active.contactCard.id, docUrl as never));
}

/**
 * Has the relay actually spoken keyhive to us?
 *
 * There is no error and no timeout when a relay ignores keyhive traffic, so
 * this is the only way to distinguish "encrypting correctly" from "shouting
 * into a void that also serves your plaintext to strangers".
 *
 * `Peer.syncpoint` is the signal: every assignment to it happens inside an
 * inbound-message handler, so a relay that drops keyhive frames can never set
 * it — no false all-clear. But it is NOT a latch. The bridge nulls it for all
 * peers on each event flush, including flushes caused by ingesting the relay's
 * own replies, so under load it is only non-null for tens of milliseconds at a
 * time. Hence: sample fast and latch the first sighting. A slow poll reports
 * "this relay is leaking your data" about a relay that is working fine.
 *
 * The adapter's `ingest-remote` event would be the tidier signal but is unsafe
 * here — it also fires for ops ingested from local storage, with no relay
 * involved at all, which is exactly the false positive this must never make.
 *
 * Reaches into private state, so it fails closed: an internals change reads as
 * "no keyhive", never as an all-clear.
 */
export async function relaySpeaksKeyhive(
  hive: AutomergeRepoKeyhive,
  { timeoutMs = 20000, intervalMs = 10 } = {}
): Promise<boolean> {
  /** The bridge's internals, as far as we depend on them. */
  interface AdapterInternals {
    remotePeerId?: string;
    syncProtocol?: { peers?: Map<string, { syncpoint: number | null }> };
  }
  const adapter = hive.networkAdapter as unknown as AdapterInternals;
  const deadline = Date.now() + timeoutMs;
  do {
    const remote = adapter.remotePeerId;
    const syncpoint = remote ? adapter.syncProtocol?.peers?.get(remote)?.syncpoint : undefined;
    if (typeof syncpoint === "number") return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() < deadline);
  return false;
}
