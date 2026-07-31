/**
 * Repo construction: identity, storage, roster-driven policy, and sync.
 *
 * `openStore` wires the pieces validated against
 * @automerge/automerge-repo@2.6.0-subduction.40:
 *
 *   new Repo({ signer, storage, subductionPolicy, subductionWebsocketEndpoints })
 *
 * The signer is the device identity (Ed25519). In the browser use
 * `WebCryptoSigner.setup()` (non-extractable key in IndexedDB); in Node the
 * CLI persists a MemorySigner's 32 secret bytes on disk (0600).
 *
 * Bootstrap order matters: the policy needs the roster, but the roster doc
 * itself arrives over sync. `openStore` therefore resolves the roster handle
 * first (create locally when new; find via URL when joining) and hands the
 * policy a live getter, so authorization always reflects the latest merged
 * roster state.
 */

import { Repo, initSubduction } from "@automerge/automerge-repo";
import type { DocHandle, StorageAdapterInterface } from "@automerge/automerge-repo";
import { emptyBamDoc, emptyDistrosDoc, emptyRosterDoc, nowIso } from "./schema.ts";
import type { BamDoc, DistrosDoc, OrgConfig, RosterDoc } from "./schema.ts";
import {
  addMember,
  domainAllowed,
  isActiveMember,
  isAdmin,
  redeemInvite,
  registerDataDomain,
  rosterPolicy,
} from "./roster.ts";
import type { KeyhiveStore } from "./keyhive.ts";

/** Matches the Signer interface of @automerge/automerge-subduction. */
export interface SignerLike {
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
  verifyingKey(): Uint8Array;
  peerId(): { toString(): string };
}

/**
 * Plain-sync relay: an Ink & Switch experiment server running `--auth open`.
 * It carries no keyhive traffic and applies an allow-all storage policy, so
 * anyone holding a document URL can read what it stores. Fine for demos,
 * wrong for PII — see docs/security-and-trust.md.
 */
export const DEFAULT_SYNC_ENDPOINT = "wss://subduction.sync.inkandswitch.com";

/**
 * Keyhive-mode relay, used when `keyhive: true`. Carries ciphertext only.
 * Declared here rather than re-exported from ./keyhive.ts so that reading the
 * constant doesn't drag keyhive's ~3.7 MB of inlined WASM into the bundle.
 */
export const KEYHIVE_SYNC_ENDPOINT = "wss://keyhive.sync.automerge.org";

/**
 * Whether this build includes keyhive at all.
 *
 * Vite replaces `__KEYHIVE_BUILD__` at compile time, so a browser build made
 * without KEYHIVE=1 constant-folds the branch in `openStore` and drops the
 * dynamic import — keeping ~1 MB gzipped of WASM out of the bundle. Node
 * (tests, CLI) never defines it, so keyhive is always available there.
 */
declare const __KEYHIVE_BUILD__: boolean | undefined;
const KEYHIVE_BUILD: boolean =
  typeof __KEYHIVE_BUILD__ === "undefined" ? true : __KEYHIVE_BUILD__;

export interface OpenStoreOptions {
  /**
   * This device's identity. Ignored under `keyhive: true` — keyhive supplies
   * the Repo's signer from a keypair it persists in `storage`, so the peer id
   * the roster keys members by comes from there instead.
   */
  signer: SignerLike;
  storage?: StorageAdapterInterface;
  /** Subduction websocket endpoints; [] disables networking (tests, offline). */
  endpoints?: string[];
  /** Join an existing org: the roster doc's automerge URL. */
  rosterUrl?: string;
  /** Create a new org with this name (mutually exclusive with rosterUrl). */
  createOrg?: string;
  /** White-label config to bake into the new org's doc (branding, features). */
  orgConfig?: Partial<OrgConfig>;
  /** Display name for this device when bootstrapping a new org. */
  deviceName?: string;
  /** Extra peer ids the policy always allows (e.g. a relay's key). */
  alwaysAllow?: string[];
  /**
   * Trust-on-first-use: connect to the configured endpoints without knowing
   * the relay's peer id in advance (needed for relays whose key isn't
   * published, like the Ink & Switch experiment relay). See
   * `RosterPolicyOptions.trustAll` for the exact semantics and caveats;
   * capture the learned id via `learnedRelayPeers` and pin it afterwards.
   */
  trustDialedRelays?: boolean;
  /**
   * QR-invite self-enrollment: when joining and this device isn't on the
   * roster yet, redeem the invite (validated against the invite's
   * tokenHash/expiry by every replica) and enroll as a volunteer.
   */
  invite?: {
    inviteId: string;
    secret: string;
    deviceName: string;
    profile?: import("./schema.ts").VolunteerProfile;
  };
  /**
   * Encrypt document content with Keyhive (see src/keyhive.ts), so the relay
   * stores ciphertext and revocation is cryptographic rather than policy-only.
   *
   * Keyhive owns the device identity in this mode — it persists its own
   * keypair in `storage` and the resulting peer id, not `signer`'s, is what
   * the roster keys members by. Documents are created protected, which changes
   * their ids, so this cannot be switched on for an existing org: those need
   * a migration that creates new documents and copies state across.
   *
   * Requires a keyhive-mode relay (KEYHIVE_SYNC_ENDPOINT). Against an
   * `--auth open` server the encryption still happens locally but nothing
   * syncs, silently.
   */
  keyhive?: boolean;
  /** Keyhive sync-server identity; defaults to the hosted keyhive relay. */
  keyhiveSyncServer?: import("./keyhive.ts").KeyhiveSyncServer;
}

export interface BamStore {
  repo: Repo;
  peerId: string;
  /**
   * Present only under `keyhive: true`. Its absence is what "policy-only
   * access control, plaintext on the wire" looks like at the type level.
   */
  hive?: import("@automerge/automerge-repo-keyhive").AutomergeRepoKeyhive;
  roster: DocHandle<RosterDoc>;
  base: DocHandle<BamDoc>;
  /**
   * The distros/shifts doc — the first grantable data domain. Undefined when
   * this device is DENIED the domain (the policy on other peers refuses to
   * serve it), or in a legacy org where no admin has booted since the split
   * (readers fall back to the legacy base.distros rows).
   */
  distros?: DocHandle<DistrosDoc>;
}

async function findWithRetry<T>(
  repo: Repo,
  url: string,
  { attempts = 8, delayMs = 1500 } = {}
): Promise<DocHandle<T>> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await repo.find<T>(url as never);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export async function openStore(opts: OpenStoreOptions): Promise<BamStore> {
  await initSubduction();

  // The policy reads the roster through this box so it is live from the
  // moment the handle resolves, while the Repo can be constructed first.
  // Under keyhive our own peer id has the same problem — the bridge builds
  // the Repo and supplies the identity — so it is read through a box too.
  const box: { roster?: DocHandle<RosterDoc>; peerId?: string } = {};
  const policy = rosterPolicy(() => box.roster?.doc(), {
    alwaysAllow: () => [...(box.peerId ? [box.peerId] : []), ...(opts.alwaysAllow ?? [])],
    trustAll: opts.trustDialedRelays,
  });

  let repo: Repo;
  let peerId: string;
  let hive: KeyhiveStore["hive"] | undefined;
  let shareWithRelay: typeof import("./keyhive.ts").shareWithRelay | undefined;
  let isProtected: typeof import("./keyhive.ts").isProtected | undefined;
  if (opts.keyhive) {
    if (!KEYHIVE_BUILD) {
      throw new Error(
        "this build was compiled without keyhive support (build with KEYHIVE=1 to include it)"
      );
    }
    if (!opts.storage) {
      throw new Error("keyhive mode needs storage: it persists the device identity and keys");
    }
    // Loaded on demand, behind the constant above: keyhive's module carries
    // its WASM inlined as base64 (~1 MB gzipped), and until the console can
    // actually turn keyhive on there is no reason to ship it to every device.
    const keyhive = await import("./keyhive.ts");
    shareWithRelay = keyhive.shareWithRelay;
    isProtected = keyhive.isProtected;
    const kh = await keyhive.openKeyhiveRepo({
      storage: opts.storage,
      docStorage: opts.storage,
      endpoints: opts.endpoints ?? [],
      subductionPolicy: policy,
      ...(opts.keyhiveSyncServer ? { syncServer: opts.keyhiveSyncServer } : {}),
    });
    ({ repo, peerId, hive } = kh);
  } else {
    peerId = opts.signer.peerId().toString();
    repo = new Repo({
      signer: opts.signer as never,
      storage: opts.storage,
      subductionPolicy: policy as never,
      subductionWebsocketEndpoints: opts.endpoints ?? [],
    });
  }
  box.peerId = peerId;

  /** Keyhive-protected documents come from create2; plain ones from create. */
  const createDoc = async <T>(initial: T): Promise<DocHandle<T>> => {
    if (!hive || !shareWithRelay) return repo.create<T>(initial);
    const handle = await repo.create2<T>(initial);
    // Without this the relay holds no capability and will not store or
    // forward the document at all.
    await shareWithRelay(hive, handle.url);
    return handle;
  };

  let roster: DocHandle<RosterDoc>;
  let base: DocHandle<BamDoc>;
  let distros: DocHandle<DistrosDoc> | undefined;
  const now = nowIso();

  if (opts.rosterUrl) {
    // Joining races the websocket connection: find() can report a document
    // unavailable before the relay link is even up, so retry with backoff.
    roster = await findWithRetry<RosterDoc>(repo, opts.rosterUrl);
    box.roster = roster;
    // QR onboarding: not on the roster yet + holding an invite -> redeem
    // it (self-enroll as volunteer; replicas validate the proof).
    if (opts.invite && !isActiveMember(roster.doc(), peerId)) {
      redeemInvite(roster, peerId, opts.invite, now);
    }
    const baseUrl = roster.doc()?.baseDocUrl;
    if (!baseUrl) throw new Error("roster has no baseDocUrl (org not fully initialized)");
    base = await findWithRetry<BamDoc>(repo, baseUrl);
    // A keyhive device joining a plaintext org would sync and edit it happily
    // while `hive` being set implies the data is encrypted. Refuse instead:
    // documents cannot be upgraded in place, so this org needs a migration.
    if (hive && !(await import("./keyhive.ts")).isProtected(roster.url)) {
      throw new Error(
        "this org's documents predate keyhive and cannot be encrypted in place — " +
          "it needs a migration that recreates them"
      );
    }
    distros = await resolveDistrosDoc(repo, roster, base, peerId, now, createDoc);
  } else {
    const org = opts.createOrg ?? "My Mutual Aid";
    roster = await createDoc<RosterDoc>(emptyRosterDoc(org, now));
    box.roster = roster;
    const orgConfig: OrgConfig = { name: org, ...(opts.orgConfig ?? {}) };
    base = await createDoc<BamDoc>(emptyBamDoc(org, now, orgConfig));
    distros = await createDoc<DistrosDoc>(emptyDistrosDoc(org, now));
    roster.change((d) => {
      d.baseDocUrl = base.url;
    });
    // Register the first grantable domain, then bootstrap the admin (both
    // use the empty-roster bootstrap path; order keeps them consistent).
    registerDataDomain(roster, peerId, {
      key: "distros",
      name: "Distros & shifts",
      docUrl: distros.url,
    }, now);
    // Bootstrap: the creating device becomes the first admin.
    addMember(roster, peerId, {
      peerId,
      name: opts.deviceName ?? "founding device",
      role: "admin",
    }, now);
  }

  return { repo, peerId, roster, base, distros, ...(hive ? { hive } : {}) };
}

/**
 * Locate (or, for admins of pre-split orgs, create) the distros doc.
 *
 * - Domain registered + this device allowed → find it (short retry; the
 *   relay may not have it yet — treat as temporarily unavailable, not fatal).
 * - Domain registered + this device DENIED → don't even dial: other peers'
 *   policies would refuse, and the console shows a no-access state instead.
 * - No domain yet (org predates the split): an ADMIN device performs the
 *   one-time migration — create the doc, move legacy base.distros rows into
 *   it, register the domain. Non-admin devices keep reading the legacy rows.
 */
async function resolveDistrosDoc(
  repo: Repo,
  roster: DocHandle<RosterDoc>,
  base: DocHandle<BamDoc>,
  peerId: string,
  now: string,
  /** Creates documents the way this store does — encrypted under keyhive. */
  createDoc: <T>(initial: T) => Promise<DocHandle<T>>
): Promise<DocHandle<DistrosDoc> | undefined> {
  const rosterDoc = roster.doc();
  const registered = rosterDoc?.dataDomains?.["distros"];
  if (registered) {
    if (!domainAllowed(rosterDoc, peerId, "distros")) return undefined;
    try {
      return await findWithRetry<DistrosDoc>(repo, registered.docUrl, {
        attempts: 4,
        delayMs: 1000,
      });
    } catch {
      return undefined; // offline/unsynced yet — console degrades gracefully
    }
  }
  if (!isAdmin(rosterDoc, peerId)) return undefined;
  const baseDoc = base.doc();
  const handle = await createDoc<DistrosDoc>(
    emptyDistrosDoc(baseDoc?.meta.org ?? rosterDoc?.org ?? "", now)
  );
  const legacy = baseDoc?.distros ?? {};
  const legacyIds = Object.keys(legacy);
  if (legacyIds.length) {
    handle.change((d) => {
      for (const id of legacyIds) {
        d.distros[id] = JSON.parse(JSON.stringify(legacy[id]));
      }
    });
    base.change((d) => {
      for (const id of legacyIds) delete d.distros[id];
    });
  }
  registerDataDomain(roster, peerId, {
    key: "distros",
    name: "Distros & shifts",
    docUrl: handle.url,
  }, now);
  return handle;
}

/**
 * The relay peer ids this store is currently connected to (excluding our
 * own key). After a trust-on-first-use connect, pin these — pass them as
 * `alwaysAllow` (CLI: saved to state.json as `relayPeer`) so future
 * sessions verify the relay instead of trusting blindly.
 */
export async function learnedRelayPeers(store: BamStore): Promise<string[]> {
  const ids = await store.repo.connectedSubductionPeerIds();
  return ids.filter((id) => id !== store.peerId);
}
