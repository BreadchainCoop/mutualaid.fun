/**
 * Roster-driven access control for the Subduction sync engine.
 *
 * Subduction authenticates every peer as an Ed25519 key (its PeerId) and
 * consults a `Policy` before serving connects, fetches, and puts. This
 * module implements that policy from the roster document: **deny by
 * default**, allow only peers with an active (non-revoked) roster entry.
 *
 * Trust model, honestly stated:
 * - Every device enforces this policy against every peer it talks to, so an
 *   unauthorized key cannot pull or push data from/to any *compliant* peer.
 * - A relay you don't run (e.g. the Ink & Switch experiment server, which
 *   currently approves all relay) will happily store-and-forward for
 *   anyone; your data still only flows to peers YOUR devices authorize,
 *   because your devices check the roster before serving them. For
 *   server-side enforcement too, run your own subduction server with
 *   `--keyhive` and the same roster.
 * - Revocation stops future syncs; it cannot un-share what a device already
 *   replicated (the same is true of any distributed system).
 *
 * The roster is itself a synced Automerge doc, so membership changes are
 * offline-capable and merge like everything else. Only admins may mutate it
 * (enforced in code here; a hostile *modified* client is out of scope for
 * policy hooks and is what keyhive-style convergent capabilities will close
 * once end-to-end auth ships in the sync server).
 */

import { parseAutomergeUrl } from "@automerge/automerge-repo";
import type { DocHandle } from "@automerge/automerge-repo";
import type { RosterDoc, RosterInvite, RosterMember, Role } from "./schema.ts";
import { newId, nowIso } from "./schema.ts";

/** Structural type of @automerge/automerge-subduction's Policy interface. */
export interface SubductionPolicyLike {
  authorizeConnect(peerId: unknown): Promise<void>;
  authorizeFetch(peerId: unknown, sedimentreeId: unknown): Promise<void>;
  authorizePut(requestor: unknown, author: unknown, sedimentreeId: unknown): Promise<void>;
  filterAuthorizedFetch(peerId: unknown, ids: unknown[]): Promise<unknown[]>;
}

export class NotAuthorized extends Error {}

/** sha256 hex — invite tokenHash validation. Sync (pure JS) so the policy
 * hooks and isActiveMember stay synchronous. */
export function sha256Hex(text: string): string {
  // Minimal SHA-256 (FIPS 180-4), operating on UTF-8 bytes.
  const bytes = new TextEncoder().encode(text);
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const len = bytes.length;
  const bitLen = len * 8;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLen >>> 0);
  new DataView(padded.buffer).setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  const w = new Int32Array(64);
  const rr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    const view = new DataView(padded.buffer, off, 64);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15]!, 7) ^ rr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rr(w[i - 2]!, 17) ^ rr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0]! + a) | 0; H[1] = (H[1]! + b) | 0; H[2] = (H[2]! + c) | 0; H[3] = (H[3]! + d) | 0;
    H[4] = (H[4]! + e) | 0; H[5] = (H[5]! + f) | 0; H[6] = (H[6]! + g) | 0; H[7] = (H[7]! + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Is a member's QR-invite self-enrollment valid against the invites map? */
function inviteEnrollmentValid(roster: RosterDoc, member: RosterMember): boolean {
  if (!member.inviteId) return true; // admin-added, nothing to validate
  const invite = roster.invites?.[member.inviteId];
  if (!invite || !member.inviteProof) return false;
  if (sha256Hex(member.inviteProof) !== invite.tokenHash) return false;
  if (member.addedAt > invite.expiresAt) return false;
  // Revoking an invite stops NEW redemptions; members who joined before the
  // revocation stay (revoke them individually if needed).
  if (invite.revokedAt && member.addedAt > invite.revokedAt) return false;
  // QR invites can never grant more than the invite's role (volunteer).
  if (member.role !== invite.role) return false;
  return true;
}

export function isActiveMember(roster: RosterDoc | undefined, peerId: string): boolean {
  if (!roster) return false;
  const member = roster.members[peerId];
  if (!member || member.revokedAt) return false;
  return inviteEnrollmentValid(roster, member);
}

export function isAdmin(roster: RosterDoc | undefined, peerId: string): boolean {
  if (!roster) return false;
  const member = roster.members[peerId];
  // isActiveMember includes invite validation, which (among other things)
  // forces invite-enrolled members to the invite's role — so a forged
  // self-enrollment claiming "admin" fails here, not just at sync time.
  return isActiveMember(roster, peerId) && member?.role === "admin";
}

/* Data domains — per-doc, per-member sync grants -------------------------- */

/**
 * The Subduction sedimentree id for an Automerge doc URL: the binaryDocumentId
 * as hex, right-padded with zeros to 32 bytes (64 hex chars). Verified
 * empirically against @automerge/automerge-repo@2.6.0-subduction.40 — the
 * ids the policy hooks receive stringify to exactly this.
 *
 * Pad to a width rather than appending a fixed 32 zeros: plain automerge doc
 * ids are 16 bytes, but keyhive-protected ones (repo.create2) are already 32,
 * and appending would produce a 48-byte id that matches nothing — silently
 * turning every per-domain denial below into a no-op.
 */
export function sedimentreeIdForDocUrl(docUrl: string): string {
  const { binaryDocumentId } = parseAutomergeUrl(docUrl as never);
  let hex = "";
  for (const b of binaryDocumentId) hex += b.toString(16).padStart(2, "0");
  return hex.padEnd(64, "0");
}

/**
 * May `peerId` sync the given data domain? Missing grant = allowed
 * (target-DENY: denying is the explicit act, so adding a new domain never
 * cuts existing members off). Admins are always allowed.
 */
export function domainAllowed(
  roster: RosterDoc | undefined,
  peerId: string,
  domainKey: string
): boolean {
  const member = roster?.members[peerId];
  if (!member) return false;
  if (member.role === "admin") return true;
  return member.dataGrants?.[domainKey] !== false;
}

/** App-level capability check (e.g. "contactFix"). Admins have every cap. */
export function hasCap(
  roster: RosterDoc | undefined,
  peerId: string,
  cap: string
): boolean {
  if (isAdmin(roster, peerId)) return true;
  if (!isActiveMember(roster, peerId)) return false;
  return roster?.members[peerId]?.caps?.[cap] === true;
}

/** May this device's app show/serve a given optional view? Missing = allowed
 * (deny is the explicit act); admins always see everything. This is the
 * APP-level tier — the underlying doc still syncs (see dataGrants for the
 * sync-level tier). */
export function viewAllowed(
  roster: RosterDoc | undefined,
  peerId: string,
  view: string
): boolean {
  const member = roster?.members[peerId];
  if (!member) return true; // pre-enrollment boot paths: don't blank the app
  if (member.role === "admin") return true;
  return member.viewGrants?.[view] !== false;
}

/** Admin action: grant (true) or deny (false) an optional view on a device. */
export function setViewGrant(
  handle: DocHandle<RosterDoc>,
  actor: string,
  peerId: string,
  view: string,
  allowed: boolean
): void {
  const doc = handle.doc();
  if (!isAdmin(doc, actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  const member = doc?.members[peerId];
  if (!member) throw new Error(`no roster member ${peerId}`);
  if (!allowed && member.role === "admin") {
    throw new NotAuthorized("admins always see every view — demote first");
  }
  handle.change((d) => {
    const m = d.members[peerId];
    if (!m) return;
    if (allowed) {
      if (m.viewGrants) delete m.viewGrants[view];
    } else {
      if (!m.viewGrants) m.viewGrants = {};
      m.viewGrants[view] = false;
    }
  });
}

export interface RosterPolicyOptions {
  /**
   * Peers always allowed regardless of roster state — the relay server's
   * key(s), and this device's own key (a repo consults the policy for its
   * own operations too in some paths). Deny-by-default applies to everyone
   * else.
   *
   * Pass a getter when the list isn't known at construction time: under
   * keyhive the Repo is built by the bridge, which supplies the device
   * identity, so our own peer id only becomes knowable afterwards.
   */
  alwaysAllow?: string[] | (() => string[]);
  /**
   * Trust-on-first-use mode: allow ANY peer. Only sane in a client-only
   * topology (browser/CLI dialing out via `subductionWebsocketEndpoints`),
   * where the only peers that can appear are relays this device chose to
   * dial — there is no listener for strangers to reach. Used to learn a
   * relay's peer id on the first connect (e.g. the Ink & Switch experiment
   * relay, whose key isn't published); callers should capture the learned
   * id and switch back to pinned mode. Never combine with real PII.
   */
  trustAll?: boolean;
}

/**
 * Build a Subduction Policy from a live view of the roster.
 *
 * `getRoster` is called on every authorization decision so revocations take
 * effect as soon as the roster doc changes — pass a closure over the roster
 * DocHandle, not a snapshot.
 */
export function rosterPolicy(
  getRoster: () => RosterDoc | undefined,
  opts: RosterPolicyOptions = {}
): SubductionPolicyLike {
  const always = (): string[] =>
    typeof opts.alwaysAllow === "function" ? opts.alwaysAllow() : opts.alwaysAllow ?? [];

  const allowed = (peerId: unknown): boolean => {
    if (opts.trustAll) return true;
    const id = String(peerId);
    return always().includes(id) || isActiveMember(getRoster(), id);
  };
  const assertAllowed = (peerId: unknown, what: string): void => {
    if (!allowed(peerId)) {
      throw new NotAuthorized(`peer ${String(peerId)} is not on the roster (${what})`);
    }
  };

  /**
   * Restricted-doc map: sedimentreeId (lowercase hex) → domain key, rebuilt
   * from the live roster on every decision so newly-registered domains and
   * grant flips apply immediately. Docs NOT in this map are governed only by
   * roster membership — deny-by-default stays at the connect/member level,
   * and only *registered domains* are additionally target-denied per member.
   * (Keyhive itself fans out over many internal sedimentrees; blanket
   * per-sedimentree denial would break sync — verified empirically.)
   */
  const restrictedDomains = (): Map<string, string> => {
    const map = new Map<string, string>();
    const domains = getRoster()?.dataDomains;
    if (!domains) return map;
    for (const [key, d] of Object.entries(domains)) {
      try {
        map.set(sedimentreeIdForDocUrl(d.docUrl).toLowerCase(), key);
      } catch {
        // Malformed docUrl: skip — never let a bad registry entry break sync.
      }
    }
    return map;
  };

  /** Is this peer allowed to sync this specific sedimentree? Peers in
   * `alwaysAllow` (own device, pinned relay) bypass domain denial: the relay
   * must store-and-forward for the whole org, and this device must always be
   * able to serve itself. */
  const sedimentreeAllowed = (peerId: unknown, sedimentreeId: unknown): boolean => {
    if (opts.trustAll) return true;
    const id = String(peerId);
    if (always().includes(id)) return true;
    const domainKey = restrictedDomains().get(String(sedimentreeId).toLowerCase());
    if (!domainKey) return true;
    return domainAllowed(getRoster(), id, domainKey);
  };

  return {
    async authorizeConnect(peerId) {
      assertAllowed(peerId, "connect");
    },
    async authorizeFetch(peerId, sedimentreeId) {
      assertAllowed(peerId, "fetch");
      if (!sedimentreeAllowed(peerId, sedimentreeId)) {
        throw new NotAuthorized(
          `peer ${String(peerId)} is denied the data domain of ${String(sedimentreeId)} (fetch)`
        );
      }
    },
    async authorizePut(requestor, _author, sedimentreeId) {
      // The requestor must be authorized; the original author may be a
      // since-revoked member whose historical commits are still valid.
      assertAllowed(requestor, "put");
      if (!sedimentreeAllowed(requestor, sedimentreeId)) {
        throw new NotAuthorized(
          `peer ${String(requestor)} is denied the data domain of ${String(sedimentreeId)} (put)`
        );
      }
    },
    async filterAuthorizedFetch(peerId, ids) {
      if (!allowed(peerId)) return [];
      return ids.filter((id) => sedimentreeAllowed(peerId, id));
    },
  };
}

/** Admin action: add (or re-activate) a member. Throws unless `actor` is an
 * admin — or the roster is empty, in which case the first member bootstraps
 * as admin. */
export function addMember(
  handle: DocHandle<RosterDoc>,
  actor: string,
  member: { peerId: string; name: string; role: Role },
  now: string = nowIso()
): void {
  const doc = handle.doc();
  const bootstrap = Object.keys(doc?.members ?? {}).length === 0;
  if (!bootstrap && !isAdmin(doc, actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  if (bootstrap && member.peerId !== actor) {
    throw new NotAuthorized("the first roster member must be the acting device (bootstrap admin)");
  }
  handle.change((d) => {
    const existing = d.members[member.peerId];
    if (existing) {
      existing.name = member.name;
      existing.role = bootstrap ? "admin" : member.role;
      delete existing.revokedAt;
      delete existing.revokedBy;
      return;
    }
    const entry: RosterMember = {
      peerId: member.peerId,
      name: member.name,
      role: bootstrap ? "admin" : member.role,
      addedBy: actor,
      addedAt: now,
    };
    d.members[member.peerId] = entry;
  });
}

/** Admin action: revoke a member's access (future syncs are denied). */
export function revokeMember(
  handle: DocHandle<RosterDoc>,
  actor: string,
  peerId: string,
  now: string = nowIso()
): void {
  if (!isAdmin(handle.doc(), actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  if (peerId === actor) {
    throw new NotAuthorized("an admin cannot revoke itself (avoid lockout)");
  }
  handle.change((d) => {
    const member = d.members[peerId];
    if (!member) throw new Error(`no roster member ${peerId}`);
    member.revokedAt = now;
    member.revokedBy = actor;
  });
}

/**
 * Admin action: change a member's role (promote a volunteer to admin, or
 * demote an admin to volunteer). Promotion clears any ``inviteId`` because an
 * explicit admin vouch supersedes the invite proof (whose role is
 * volunteer-only, so ``inviteEnrollmentValid`` would otherwise reject the new
 * admin role). Refuses to demote the last active admin (lockout guard).
 */
export function setRole(
  handle: DocHandle<RosterDoc>,
  actor: string,
  peerId: string,
  role: Role,
  now: string = nowIso()
): void {
  const doc = handle.doc();
  if (!isAdmin(doc, actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  const member = doc?.members[peerId];
  if (!member) throw new Error(`no roster member ${peerId}`);
  if (role === "volunteer" && member.role === "admin" && !member.revokedAt) {
    const activeAdmins = Object.values(doc!.members).filter(
      (m) => !m.revokedAt && m.role === "admin"
    );
    if (activeAdmins.length <= 1) {
      throw new NotAuthorized("cannot demote the last admin (avoid lockout)");
    }
  }
  handle.change((d) => {
    const m = d.members[peerId];
    if (!m) return;
    m.role = role;
    if (role === "admin") {
      delete m.inviteId;
      delete m.inviteProof;
    }
  });
}

/**
 * Register a grantable data domain (e.g. "distros" → its doc URL). Admin-only,
 * except bootstrap: the org-creating device registers domains before any
 * roster entry exists mid-`openStore`, mirroring addMember's bootstrap path.
 */
export function registerDataDomain(
  handle: DocHandle<RosterDoc>,
  actor: string,
  domain: { key: string; name: string; docUrl: string },
  now: string = nowIso()
): void {
  const doc = handle.doc();
  const bootstrap = Object.keys(doc?.members ?? {}).length === 0;
  if (!bootstrap && !isAdmin(doc, actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  handle.change((d) => {
    if (!d.dataDomains) d.dataDomains = {};
    d.dataDomains[domain.key] = {
      name: domain.name,
      docUrl: domain.docUrl,
      createdAt: now,
    };
  });
}

/** Admin action: grant (true) or deny (false) a member's access to a data
 * domain. Granting removes the deny mark (missing = allowed). Enforced at
 * the sync layer by every compliant peer via rosterPolicy. */
export function setDomainGrant(
  handle: DocHandle<RosterDoc>,
  actor: string,
  peerId: string,
  domainKey: string,
  allowed: boolean
): void {
  const doc = handle.doc();
  if (!isAdmin(doc, actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  const member = doc?.members[peerId];
  if (!member) throw new Error(`no roster member ${peerId}`);
  if (!allowed && member.role === "admin") {
    throw new NotAuthorized("admins always see every domain — demote first");
  }
  handle.change((d) => {
    const m = d.members[peerId];
    if (!m) return;
    if (allowed) {
      if (m.dataGrants) delete m.dataGrants[domainKey];
    } else {
      if (!m.dataGrants) m.dataGrants = {};
      m.dataGrants[domainKey] = false;
    }
  });
}

/** Admin action: grant or remove an app-level capability (e.g. "contactFix"). */
export function setCap(
  handle: DocHandle<RosterDoc>,
  actor: string,
  peerId: string,
  cap: string,
  on: boolean
): void {
  const doc = handle.doc();
  if (!isAdmin(doc, actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  if (!doc?.members[peerId]) throw new Error(`no roster member ${peerId}`);
  handle.change((d) => {
    const m = d.members[peerId];
    if (!m) return;
    if (on) {
      if (!m.caps) m.caps = {};
      m.caps[cap] = true;
    } else if (m.caps) {
      delete m.caps[cap];
    }
  });
}

/** Self-service: a device stamps its own lastSeenAt (at boot). Throttled to
 * once per hour so routine opens don't churn the roster doc. */
export function touchLastSeen(
  handle: DocHandle<RosterDoc>,
  peerId: string,
  now: string = nowIso()
): void {
  const member = handle.doc()?.members[peerId];
  if (!member) return;
  const last = member.lastSeenAt;
  if (last && new Date(now).getTime() - new Date(last).getTime() < 3_600_000) return;
  handle.change((d) => {
    const m = d.members[peerId];
    if (m) m.lastSeenAt = now;
  });
}

/** Admin action: un-revoke a member. Clears the invite linkage too, since the
 * admin is now vouching for the device directly (independent of invite state). */
export function reinstateMember(
  handle: DocHandle<RosterDoc>,
  actor: string,
  peerId: string
): void {
  if (!isAdmin(handle.doc(), actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  handle.change((d) => {
    const member = d.members[peerId];
    if (!member) throw new Error(`no roster member ${peerId}`);
    delete member.revokedAt;
    delete member.revokedBy;
    delete member.inviteId;
    delete member.inviteProof;
  });
}

/* QR invites — bearer-credential onboarding ------------------------------ */

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CreateInviteOptions {
  /** Label shown in the roster view, e.g. "July distro volunteers". */
  name: string;
  /** Days until redemptions stop working. Default 7. */
  expiresInDays?: number;
  /** Soft redemption cap (honest-client enforced). Default 20. */
  maxUses?: number;
  /** Capability presets everyone joining with this invite receives. */
  caps?: { [cap: string]: boolean };
  /** Data-domain presets (false = denied) applied at redemption. */
  dataGrants?: { [domainKey: string]: boolean };
  /** Per-view presets (false = hidden + refused on that device). */
  viewGrants?: { [view: string]: boolean };
}

/**
 * Admin action: mint a QR invite. Returns the SECRET — it exists only in
 * this return value (and the QR/link built from it); the roster stores its
 * sha256. Role is always "volunteer": admin rights are never QR-grantable.
 */
export function createInvite(
  handle: DocHandle<RosterDoc>,
  actor: string,
  opts: CreateInviteOptions,
  now: string = nowIso()
): { invite: RosterInvite; secret: string } {
  if (!isAdmin(handle.doc(), actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  const secret = randomSecret();
  const expiresAt = new Date(
    new Date(now).getTime() + (opts.expiresInDays ?? 7) * 86_400_000
  ).toISOString();
  const invite: RosterInvite = {
    id: newId(),
    name: opts.name,
    tokenHash: sha256Hex(secret),
    role: "volunteer",
    createdBy: actor,
    createdAt: now,
    expiresAt,
    maxUses: opts.maxUses ?? 20,
  };
  if (opts.caps && Object.keys(opts.caps).length) invite.caps = { ...opts.caps };
  if (opts.dataGrants && Object.keys(opts.dataGrants).length) {
    invite.dataGrants = { ...opts.dataGrants };
  }
  if (opts.viewGrants && Object.keys(opts.viewGrants).length) {
    invite.viewGrants = { ...opts.viewGrants };
  }
  handle.change((d) => {
    if (!d.invites) d.invites = {};
    d.invites[invite.id] = invite;
  });
  return { invite, secret };
}

/** Admin action: stop future redemptions of an invite (existing members
 * who joined before the revocation keep their access). */
export function revokeInvite(
  handle: DocHandle<RosterDoc>,
  actor: string,
  inviteId: string,
  now: string = nowIso()
): void {
  if (!isAdmin(handle.doc(), actor)) {
    throw new NotAuthorized(`peer ${actor} is not an active admin`);
  }
  handle.change((d) => {
    const invite = d.invites?.[inviteId];
    if (!invite) throw new Error(`no invite ${inviteId}`);
    invite.revokedAt = now;
    invite.revokedBy = actor;
  });
}

/**
 * Self-enrollment: a scanning device redeems an invite secret and writes
 * its own volunteer entry. Every replica re-validates the entry against the
 * invite's tokenHash/expiry/revocation (see inviteEnrollmentValid), so a
 * bogus proof never grants access on compliant peers. `maxUses` is
 * enforced here (honest clients) and is visible to admins; a modified
 * client exceeding it is the same threat model as any roster write today.
 */
export function redeemInvite(
  handle: DocHandle<RosterDoc>,
  peerId: string,
  args: {
    inviteId: string;
    secret: string;
    deviceName: string;
    /** Optional self-described volunteer profile from the join screen. */
    profile?: import("./schema.ts").VolunteerProfile;
  },
  now: string = nowIso()
): RosterMember {
  const doc = handle.doc();
  const invite = doc?.invites?.[args.inviteId];
  if (!invite) throw new NotAuthorized(`no such invite ${args.inviteId}`);
  if (sha256Hex(args.secret) !== invite.tokenHash) {
    throw new NotAuthorized("invite secret does not match");
  }
  if (invite.revokedAt && now > invite.revokedAt) {
    throw new NotAuthorized("invite has been revoked");
  }
  if (now > invite.expiresAt) throw new NotAuthorized("invite has expired");
  const uses = Object.values(doc?.members ?? {}).filter(
    (m) => m.inviteId === args.inviteId
  ).length;
  const existing = doc?.members?.[peerId];
  if (!existing && uses >= invite.maxUses) {
    throw new NotAuthorized("invite is used up");
  }
  handle.change((d) => {
    const entry: RosterMember = {
      peerId,
      name: args.deviceName,
      role: invite.role,
      addedBy: `invite:${invite.id}`,
      addedAt: now,
      inviteId: invite.id,
      inviteProof: args.secret,
    };
    // The invite carries the permissions the admin chose when minting it —
    // volunteers arrive already set up, no follow-up grants needed.
    if (invite.caps && Object.keys(invite.caps).length) entry.caps = { ...invite.caps };
    if (invite.dataGrants && Object.keys(invite.dataGrants).length) {
      entry.dataGrants = { ...invite.dataGrants };
    }
    if (invite.viewGrants && Object.keys(invite.viewGrants).length) {
      entry.viewGrants = { ...invite.viewGrants };
    }
    if (args.profile) {
      const profile: Record<string, unknown> = {};
      if (args.profile.languages?.length) profile.languages = [...args.profile.languages];
      if (args.profile.neighborhood) profile.neighborhood = args.profile.neighborhood;
      if (args.profile.vehicle) profile.vehicle = args.profile.vehicle;
      if (args.profile.availability?.length) profile.availability = [...args.profile.availability];
      if (args.profile.skills) profile.skills = args.profile.skills;
      if (Object.keys(profile).length) {
        entry.profile = profile as RosterMember["profile"];
      }
    }
    d.members[peerId] = entry;
  });
  return handle.doc()!.members[peerId]!;
}

/** Self-service: a member updates their OWN volunteer profile. */
export function updateOwnProfile(
  handle: DocHandle<RosterDoc>,
  peerId: string,
  profile: import("./schema.ts").VolunteerProfile
): void {
  if (!isActiveMember(handle.doc(), peerId)) {
    throw new NotAuthorized("only active members can edit their profile");
  }
  handle.change((d) => {
    const m = d.members[peerId];
    if (!m) return;
    const next: Record<string, unknown> = {};
    if (profile.languages?.length) next.languages = [...profile.languages];
    if (profile.neighborhood?.trim()) next.neighborhood = profile.neighborhood.trim();
    if (profile.vehicle && profile.vehicle !== "none") next.vehicle = profile.vehicle;
    if (profile.availability?.length) next.availability = [...profile.availability];
    if (profile.skills?.trim()) next.skills = profile.skills.trim();
    if (Object.keys(next).length) {
      m.profile = next as RosterMember["profile"];
    } else if (m.profile !== undefined) {
      delete m.profile;
    }
  });
}

/* Invite links ------------------------------------------------------------ */

export interface InvitePayload {
  v: 1;
  org?: string;
  rosterUrl: string;
  endpoint?: string;
  relayPeer?: string;
  inviteId: string;
  secret: string;
}

function base64UrlEncode(text: string): string {
  const b64 = (typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(text)))
    : Buffer.from(text, "utf-8").toString("base64"));
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): string {
  const b64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  return typeof atob === "function"
    ? decodeURIComponent(escape(atob(b64)))
    : Buffer.from(b64, "base64").toString("utf-8");
}

/** The URL a QR code encodes: `<consoleUrl>#invite=<base64url(payload)>`. */
export function buildInviteUrl(consoleUrl: string, payload: InvitePayload): string {
  const base = consoleUrl.replace(/#.*$/, "");
  return `${base}#invite=${base64UrlEncode(JSON.stringify(payload))}`;
}

/** Parse an invite from a full URL, a fragment, or a bare payload string. */
export function parseInviteUrl(input: string): InvitePayload | null {
  const match = input.match(/#invite=([A-Za-z0-9_-]+)/);
  const encoded = match ? match[1]! : input.trim();
  try {
    const payload = JSON.parse(base64UrlDecode(encoded)) as InvitePayload;
    if (payload && payload.v === 1 && payload.rosterUrl && payload.secret && payload.inviteId) {
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}
