/**
 * Repo construction: identity, storage, roster-driven policy, and sync.
 *
 * Org data is always end-to-end encrypted (see ./keyhive.ts), so `openStore`
 * builds its Repo through the keyhive bridge, which supplies the device
 * identity, the document id factory and the encryption interceptor. Our roster
 * policy is still installed on top: keyhive decides who can *decrypt*, the
 * roster decides who we will *talk to*.
 *
 * Bootstrap order matters twice over. The policy needs the roster, but the
 * roster doc itself arrives over sync — so the policy gets a live getter rather
 * than a snapshot, and authorization always reflects the latest merged state.
 * And a joining device must publish its contact card into the roster before any
 * admin can grant it keys, which is why the roster is the one document that is
 * NOT encrypted (see `openStore` below).
 */

import { Repo, initSubduction } from "@automerge/automerge-repo";
import type { DocHandle, StorageAdapterInterface } from "@automerge/automerge-repo";
import {
  KEYHIVE_SYNC_ENDPOINT,
  myContactCard,
  openKeyhiveRepo,
  reconcileAccess,
  shareWithRelay,
  syncServerPeerIdHex,
  type KeyhiveStore,
  type KeyhiveSyncServer,
} from "./keyhive.ts";
import { emptyBamDoc, emptyDistrosDoc, emptyRosterDoc, nowIso } from "./schema.ts";
import type { BamDoc, DistrosDoc, OrgConfig, RosterDoc } from "./schema.ts";
import {
  addMember,
  domainAllowed,
  isActiveMember,
  isAdmin,
  keyhiveGrantees,
  publishContactCard,
  redeemInvite,
  registerDataDomain,
  rosterPolicy,
} from "./roster.ts";
/**
 * The sync relay. It only ever sees ciphertext, so it can shuttle updates
 * between devices without being able to read a name or a phone number.
 *
 * It must run in keyhive mode. A `--auth open` subduction server (such as the
 * older community relay at subduction.sync.inkandswitch.com) drops encrypted
 * traffic silently — no error, no timeout, just an org that never syncs.
 */
export const DEFAULT_SYNC_ENDPOINT = KEYHIVE_SYNC_ENDPOINT;

export interface OpenStoreOptions {
  /**
   * Where this device keeps everything: its identity keypair, its encryption
   * state, and the documents. Required — without it the device would mint a
   * new identity on every load and lose the org on reload.
   */
  storage: StorageAdapterInterface;
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
   * Which sync server's identity to trust. Defaults to the hosted keyhive
   * relay; pass an explicit identity to point at one you run yourself.
   */
  syncServer?: KeyhiveSyncServer;
}

export interface BamStore {
  repo: Repo;
  peerId: string;
  /** The encryption layer: doc membership, contact cards, grants. */
  hive: KeyhiveStore["hive"];
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

  // The policy reads the roster and our own peer id through this box so both
  // are live from the moment they resolve: the bridge builds the Repo (and
  // supplies the identity), and the roster arrives over sync afterwards.
  const box: { roster?: DocHandle<RosterDoc>; peerId?: string } = {};
  // The sync server is never a roster member, so a deny-by-default policy
  // would refuse the connection before any encrypted traffic could flow. Its
  // id has to be known up front — the Repo dials during construction.
  const syncServer = syncServerPeerIdHex(opts.syncServer);
  const policy = rosterPolicy(() => box.roster?.doc(), {
    alwaysAllow: () => [
      syncServer,
      ...(box.peerId ? [box.peerId] : []),
      ...(opts.alwaysAllow ?? []),
    ],
  });

  const { repo, peerId, hive } = await openKeyhiveRepo({
    storage: opts.storage,
    endpoints: opts.endpoints ?? [],
    subductionPolicy: policy,
    ...(opts.syncServer ? { syncServer: opts.syncServer } : {}),
  });
  box.peerId = peerId;

  /**
   * Create an encrypted document. NOT for the roster: see below, that one has
   * to stay readable so a joining device can introduce itself.
   */
  const createDataDoc = async <T>(initial: T): Promise<DocHandle<T>> => {
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
    // Publish our card before looking for the data: until an admin can see it,
    // nobody can grant us the keys, and the fetch below would find nothing.
    publishContactCard(roster, peerId, myContactCard(hive));

    const baseUrl = roster.doc()?.baseDocUrl;
    if (!baseUrl) throw new Error("roster has no baseDocUrl (org not fully initialized)");
    base = await findWithRetry<BamDoc>(repo, baseUrl);
    distros = await resolveDistrosDoc(repo, roster, base, peerId, now, createDataDoc);
  } else {
    const org = opts.createOrg ?? "My Mutual Aid";
    // The roster stays UNENCRYPTED even in an encrypted org. A joining device
    // has to read it to publish its contact card and find the data documents,
    // and it cannot be granted keys before anyone has seen that card — an
    // encrypted roster would be a lock whose key is inside the box. The PII
    // lives in the data documents below; the roster holds device names, roles
    // and public keys.
    roster = repo.create<RosterDoc>(emptyRosterDoc(org, now));
    box.roster = roster;
    const orgConfig: OrgConfig = { name: org, ...(opts.orgConfig ?? {}) };
    base = await createDataDoc<BamDoc>(emptyBamDoc(org, now, orgConfig));
    distros = await createDataDoc<DistrosDoc>(emptyDistrosDoc(org, now));
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
    publishContactCard(roster, peerId, myContactCard(hive));
  }

  const store: BamStore = { repo, peerId, hive, roster, base, distros };
  // Hand out (and take away) decryption keys to match the roster. Admins only:
  // it is the only role that can, and a volunteer attempting it just fails.
  if (isAdmin(roster.doc(), peerId)) await syncAccess(store);
  return store;
}

/**
 * Make decryption access match the roster, for every encrypted document.
 *
 * Call after any membership or data-grant change. Safe to call often: it
 * compares the two lists and only acts on the difference. Non-admins and
 * unencrypted orgs are no-ops, so callers don't need to check first.
 */
export async function syncAccess(
  store: BamStore
): Promise<{ granted: string[]; revoked: string[]; failed: string[] }> {
  if (!isAdmin(store.roster.doc(), store.peerId)) {
    return { granted: [], revoked: [], failed: [] };
  }

  // A volunteer denied a data domain is left out of that document's key, so
  // the denial holds against a peer that ignores the sync policy too.
  const targets: [DocHandle<unknown>, string | undefined][] = [[store.base, undefined]];
  if (store.distros) targets.push([store.distros, "distros"]);

  const all = { granted: [] as string[], revoked: [] as string[], failed: [] as string[] };
  for (const [handle, domain] of targets) {
    const desired = keyhiveGrantees(store.roster.doc(), domain).map((m) => ({
      peerId: m.peerId,
      contactCard: m.contactCard,
      role: (m.role === "admin" ? "admin" : "edit") as "admin" | "edit",
    }));
    const result = await reconcileAccess(store.hive, store.repo, handle.url, desired);
    all.granted.push(...result.granted);
    all.revoked.push(...result.revoked);
    all.failed.push(...result.failed);
  }
  return all;
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
