/**
 * CRDT document schema for the local-first BAM system.
 *
 * Two Automerge documents:
 *
 * - The ROSTER doc (`RosterDoc`) is the access-control root: which Ed25519
 *   device keys (Subduction PeerIds, hex) may sync, and with what role. It
 *   drives the Subduction `Policy` hooks — see roster.ts.
 * - The BASE doc (`BamDoc`) holds the operational data: the same six-table
 *   model as the server implementation (see ../../bam/models.py), keyed by
 *   stable string ids so concurrent edits from different devices merge
 *   per-record instead of conflicting.
 *
 * Design notes:
 * - Ids are strings. Migrated rows keep their Airtable record id; new rows
 *   get `crockford(random)` ids from newId().
 * - Timestamps are ISO-8601 UTC strings, dates are YYYY-MM-DD — Automerge
 *   scalars, so last-writer-wins per field, which matches the operational
 *   semantics (a later status change should win).
 * - There is no SMS provider inside the CRDT world: an outreach blast
 *   appends to `smsOutbox`; any connected gateway device (or an operator)
 *   drains the outbox and stamps `sentAt`. This is the local-first version
 *   of the spec 5 `send_sms` function.
 */

export type RequestStatus = "Open" | "Timeout" | "Delivered";
export type AppointmentStatus = "Booked" | "Checked-in" | "Missed";
export type Role = "admin" | "volunteer";

export interface Household {
  id: string;
  name?: string;
  phoneNumber?: string; // E.164
  phoneHash?: string; // sha256, survives anonymization
  invalidPhoneNumber: boolean;
  intlPhoneNumber: boolean;
  email?: string;
  emailError?: string;
  languages: string[];
  /** The language outreach should lead with; `languages` is "also speaks". */
  preferredLanguage?: string;
  notes?: string;
  appointmentDate?: string; // YYYY-MM-DD
  appointmentTime?: string;
  appointmentStatus?: AppointmentStatus;
  missedAppointmentCount: number;
  lastTexted?: string; // YYYY-MM-DD
  lastCalled?: string;
  lastEmailed?: string;
  lastAttended?: string;
  needsDelivery: boolean;
  needsEmailOutreach: boolean;
  /** Last delivery date per catalog type key — drives per-item cooldowns. */
  lastDeliveredByType?: { [typeKey: string]: string }; // YYYY-MM-DD
  /** Set when this household's distro was cancelled after booking. */
  needsRebooking?: boolean;
  rebookFrom?: string; // the cancelled YYYY-MM-DD
  /** Items bagged for after-hours pickup (the "set-aside" flow). */
  setAside?: { note: string; at: string; by: string };
  anonymizedAt?: string; // ISO datetime
  createdAt: string; // ISO datetime
  updatedAt: string;
}

export interface RequestRow {
  id: string;
  type: string; // catalog key, or raw label when unresolvable
  householdId: string;
  status: RequestStatus;
  notes?: string;
  /** Accepted-but-paced (per-item cooldown); excluded from outreach until then. */
  pacedUntil?: string; // YYYY-MM-DD
  requestOpenedAt: string; // ISO datetime
  statusLastUpdatedAt: string;
  processingDate?: string; // YYYY-MM-DD (+14 / +30 on close)
  streetAddress?: string;
  cityState?: string;
  zipCode?: string;
  geocode?: string;
  address?: string;
  bin?: string; // NYC Building Identification Number (furniture delivery)
  addressAccuracy?: string; // Apartment/Building/No result/...
  createdAt: string;
  updatedAt: string;
}

export interface SocialServiceRequestRow {
  id: string;
  type: string;
  householdId: string;
  status: RequestStatus;
  notes?: string;
  /** Which partner org fulfills/fulfilled this (status × partner model). */
  partnerOrg?: string;
  pacedUntil?: string; // YYYY-MM-DD
  internetAccess: string[];
  roofAccessible: boolean;
  streetAddress?: string;
  cityState?: string;
  zipCode?: string;
  address?: string;
  meshStatus?: string; // raw mesh install pipeline stage (type === mesh_internet)
  bin?: string; // NYC Building Identification Number (Mesh)
  addressAccuracy?: string;
  requestOpenedAt: string;
  statusLastUpdatedAt: string;
  processingDate?: string;
  createdAt: string;
  updatedAt: string;
}

export type DistroStatus = "Scheduled" | "Cancelled";

export interface Distro {
  id: string;
  dateTime: string; // ISO datetime
  location?: string;
  durationMinutes?: number;
  appointments?: string;
  notes?: string;
  /** Max booked appointments per 30-minute slot (unset = uncapped). */
  slotCapacity?: number;
  status?: DistroStatus; // unset = Scheduled (legacy rows)
  cancelledAt?: string; // ISO datetime
  cancelReason?: string;
  createdAt: string;
}

/**
 * A claimable staffing slot for a distro/event (the coverage board).
 * Flat rows (not nested under a distro) so concurrent claims merge cleanly.
 */
export interface ShiftSlot {
  id: string;
  date: string; // YYYY-MM-DD
  /** e.g. "Sunday distro", "Town hall". */
  eventLabel: string;
  /** e.g. "Check-in", "Lift", "Interpreter", "Driver". */
  role: string;
  /** Language the role requires, if any (e.g. "Spanish", "Arabic"). */
  languageRequired?: string;
  /** How many people this role needs. */
  needed: number;
  notes?: string;
  /** Claims keyed by device PeerId — claim/release merge per-device. */
  claims: { [peerId: string]: { name: string; at: string } };
  createdBy: string; // PeerId hex
  createdAt: string;
}

export interface OutboxMessage {
  id: string;
  to: string; // E.164 phone, or an email address when channel === "email"
  body: string;
  householdId: string;
  /** Delivery channel a gateway device should use. Unset = "sms" (legacy). */
  channel?: "sms" | "email";
  subject?: string; // email only
  queuedAt: string; // ISO datetime
  queuedBy: string; // PeerId hex of the device that queued it
  sentAt?: string; // stamped by whichever gateway device sends it
  error?: string;
}

/**
 * Per-catalog-item operational policy (Maria's cooldown + seasonal asks).
 * Keyed by catalog type key in BamDoc.itemPolicies.
 */
export interface ItemPolicy {
  /** Days after a DELIVERY before the same household's re-request re-enters
   * outreach. First requests are never paced. 0/unset = no cooldown. */
  cooldownDays?: number;
  /** Seasonal window as MM-DD (inclusive); wraps the year boundary when
   * from > until (e.g. 12-01 → 02-28). Outside it, intake pauses the item. */
  seasonFrom?: string;
  seasonUntil?: string;
  /** Hard off-switch: hide from intake entirely (independent of season). */
  disabled?: boolean;
  /** Days an OPEN request lives before auto-expiring (overrides the catalog
   * default of 14/30) — urgent items short, furniture long. */
  expiryDays?: number;
}

/** A post-distro stock count: what's actually on the shelves. */
export interface InventoryCount {
  id: string;
  date: string; // YYYY-MM-DD (the distro/count date)
  by: string; // volunteer name or peer prefix
  /** Counted items, catalog type key → units on hand. */
  counts: { [typeKey: string]: number };
  notes?: string;
  createdAt: string;
}

/** A doorstep-delivery task on the dispatch board (lives in the distros
 * doc, next to shift slots — same claim mechanics, same access domain). */
export interface DeliveryTask {
  id: string;
  /** Linked household, when created from a lookup. */
  householdId?: string;
  /** Denormalized so the board renders and prints without another lookup. */
  householdName?: string;
  phone?: string;
  address?: string;
  /** What's being delivered, in plain words ("2 bags clothing + a walker"). */
  items: string;
  notes?: string;
  status: "Open" | "Claimed" | "Delivered";
  claimedBy?: { peerId: string; name: string; at: string };
  deliveredAt?: string;
  createdBy: string; // PeerId hex
  createdAt: string;
}

/**
 * White-label instance config, stored IN the CRDT doc so it syncs to every
 * device (no server, no rebuild). The founding admin sets it at org creation;
 * the console themes itself from it. Mirrors the server's InstanceConfig shape.
 */
export interface OrgConfig {
  name: string;
  shortName?: string;
  tagline?: string;
  timezone?: string;
  branding?: {
    primaryColor?: string;
    accentColor?: string;
    themeColor?: string;
    title?: string;
    logo?: string; // "hands" | "initials" | "none" | raw inline <svg>
  };
  /** Per-view feature toggles, e.g. { furniture: false }. Missing = enabled. */
  features?: { [view: string]: boolean };
  /** Referral cues shown to check-in volunteers ("invite them to scan the
   * English-classes QR"). `showForTypes` limits the cue to households with
   * those open request types; empty/missing = always show. */
  referrals?: Array<{ label: string; url?: string; showForTypes?: string[] }>;
  /** Partner orgs for the status × partner model + fulfillment sync. */
  partnerOrgs?: string[];
  /** Encrypted-checkpoint history. CIDs/sizes only — the ciphertext lives on
   * IPFS/disk and is useless without the passphrase, which is NEVER stored. */
  checkpoints?: Array<{
    at: string; // ISO datetime
    by: string; // device name or peer prefix
    size: number; // ciphertext bytes
    cid?: string; // present when pinned to IPFS
    note?: string;
  }>;
}

export interface BamDoc {
  meta: {
    org: string;
    schemaVersion: number;
    createdAt: string;
  };
  /** Instance identity/branding/features (white-label). */
  config?: OrgConfig;
  households: { [id: string]: Household };
  requests: { [id: string]: RequestRow };
  socialServiceRequests: { [id: string]: SocialServiceRequestRow };
  /** LEGACY location of distros. New orgs keep this empty: distros live in
   * their own doc (DistrosDoc) so access to them is grantable per device.
   * Readers must merge both; writers target the distros doc. */
  distros: { [id: string]: Distro };
  /** Fulfilled Request Count, one entry per "YYYY-MM-DD|typeKey". */
  fulfilledCounts: { [dateAndType: string]: number };
  smsOutbox: { [id: string]: OutboxMessage };
  /** Per-item cooldown/seasonal policy, keyed by catalog type key. */
  itemPolicies?: { [typeKey: string]: ItemPolicy };
  /** Live stock levels: catalog type key → units on hand. Missing key =
   * untracked (assume available); 0 = tracked and OUT. */
  inventory?: { [typeKey: string]: { onHand: number; updatedAt: string; updatedBy: string } };
  /** Post-distro count history, newest useful for trends. */
  inventoryLog?: { [id: string]: InventoryCount };
}

/**
 * The DISTROS doc: distro events + the shift/coverage board, split from the
 * base doc so an admin can grant/deny it per device — the policy target-denies
 * this doc's sedimentree for denied peers (see roster.ts). This is the first
 * grantable data domain ("distros"); the registry lives in RosterDoc.dataDomains.
 */
export interface DistrosDoc {
  meta: { org: string; domain: "distros"; createdAt: string };
  distros: { [id: string]: Distro };
  shiftSlots: { [id: string]: ShiftSlot };
  /** The delivery dispatch board (added later; write paths create the map). */
  deliveries?: { [id: string]: DeliveryTask };
}

/**
 * A volunteer's self-described profile — collected on the QR join screen and
 * editable in the Volunteers view. Used to match people to work: languages
 * feed interpreter shifts, vehicle feeds driver slots, availability feeds
 * scheduling conversations.
 */
export interface VolunteerProfile {
  /** Full catalog language labels they can work in. */
  languages?: string[];
  /** Neighborhood / area, free text ("Bushwick", "Ridgewood"). */
  neighborhood?: string;
  /** "none" | "bike" | "car" | "van" (free string for anything else). */
  vehicle?: string;
  /** e.g. ["Weekday mornings", "Weekends"]. */
  availability?: string[];
  /** Anything else they want the team to know ("RN", "can lift heavy"). */
  skills?: string;
}

export interface RosterMember {
  /** Subduction PeerId (hex of the Ed25519 verifying key). */
  peerId: string;
  name: string;
  role: Role;
  /** Self-described volunteer profile (see VolunteerProfile). */
  profile?: VolunteerProfile;
  addedBy: string; // PeerId hex, or "invite:<inviteId>" for self-enrollment
  addedAt: string; // ISO datetime
  revokedAt?: string;
  revokedBy?: string;
  /** Set when self-enrolled via a QR invite. */
  inviteId?: string;
  /** The invite secret (preimage of the invite's tokenHash) — replicas
   * validate sha256(inviteProof) === invite.tokenHash. Visible to roster
   * members only; invites are short-lived and revocable. */
  inviteProof?: string;
  /** Per-data-domain sync grants. Missing/true = allowed, false = DENIED —
   * deny is the explicit act (target-deny), so upgrades never cut anyone off.
   * Admins are always allowed regardless of this map. */
  dataGrants?: { [domainKey: string]: boolean };
  /** App-level capability grants (accident guards enforced in the adapter),
   * e.g. { contactFix: true } lets a trusted volunteer edit phone/email. */
  caps?: { [cap: string]: boolean };
  /** Per-device VIEW grants: which optional screens/tables this device's app
   * shows and serves. Missing/true = allowed, false = hidden AND refused by
   * the adapter. Weaker than dataGrants (the doc still syncs — see
   * docs/data-access.md for the two tiers); admins are always allowed. */
  viewGrants?: { [view: string]: boolean };
  /** Self-stamped by the device at boot — drives access-recert sweeps. */
  lastSeenAt?: string; // ISO datetime
  /**
   * This device's Keyhive contact card (JSON), published by the device itself
   * in an encrypted org. Admins need it to grant decryption access, so a
   * member without one is on the roster but cannot yet read any data — the
   * card is how "add someone" becomes "give someone the keys".
   */
  contactCard?: string;
}

/**
 * A QR-invite: a bearer credential minted by an admin. The SECRET travels
 * only inside the QR/link; the roster stores its sha256 so every replica
 * can validate self-enrollments without being able to mint new ones.
 */
export interface RosterInvite {
  id: string;
  /** Label shown in the roster view, e.g. "July distro volunteers". */
  name: string;
  /** sha256 hex of the invite secret. */
  tokenHash: string;
  /** Always "volunteer" — admin roles are never grantable by QR. */
  role: Role;
  createdBy: string; // admin PeerId hex
  createdAt: string;
  expiresAt: string; // ISO datetime; redemptions after this are invalid
  /** Soft cap, enforced at redemption time by honest clients and visible
   * to admins (see roster.ts for the trust discussion). */
  maxUses: number;
  /** Permission presets applied to everyone who joins with this invite:
   * capability grants (e.g. { contactFix: true }) … */
  caps?: { [cap: string]: boolean };
  /** …data-domain grants (false = denied, e.g. { distros: false }) … */
  dataGrants?: { [domainKey: string]: boolean };
  /** …and per-view grants (false = that screen/table hidden + refused). */
  viewGrants?: { [view: string]: boolean };
  revokedAt?: string;
  revokedBy?: string;
}

export interface RosterDoc {
  org: string;
  createdAt: string;
  /** keyed by PeerId hex */
  members: { [peerId: string]: RosterMember };
  /** QR-invites, keyed by invite id. */
  invites?: { [inviteId: string]: RosterInvite };
  /**
   * The Automerge URL of the base document, so a newly-invited device only
   * needs the roster URL + relay endpoint to find everything.
   */
  baseDocUrl?: string;
  /**
   * Grantable data domains: the docs the sync policy can target-deny per
   * member (see RosterMember.dataGrants). Keyed by domain key ("distros").
   */
  dataDomains?: {
    [key: string]: { name: string; docUrl: string; createdAt: string };
  };
  /**
   * This org's data documents are Keyhive-encrypted: only devices an admin has
   * granted access can decrypt them, and a relay stores ciphertext it cannot
   * read. The roster itself stays unencrypted — a joining device has to read
   * it to publish its contact card before anyone can grant it anything.
   */
  encrypted?: boolean;
}

/** Automerge rejects explicit `undefined`; drop such keys (recursively) so an
 * org config with empty optional fields (e.g. no short name) can be written. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

export function emptyBamDoc(org: string, now: string, config?: OrgConfig): BamDoc {
  return {
    meta: { org, schemaVersion: 1, createdAt: now },
    config: stripUndefined(config ?? { name: org }),
    households: {},
    requests: {},
    socialServiceRequests: {},
    distros: {},
    fulfilledCounts: {},
    smsOutbox: {},
  };
}

export function emptyRosterDoc(org: string, now: string): RosterDoc {
  return { org, createdAt: now, members: {} };
}

export function emptyDistrosDoc(org: string, now: string): DistrosDoc {
  return {
    meta: { org, domain: "distros", createdAt: now },
    distros: {},
    shiftSlots: {},
  };
}

/**
 * The optional console views an admin can grant/deny PER DEVICE (core views —
 * home, check-in, intake, look up, volunteers — are always on). Single source
 * of truth for the Volunteers UI, invite presets, and the adapter guards.
 */
export const DEVICE_VIEWS: Array<{ view: string; label: string }> = [
  { view: "appointments", label: "Appointments" },
  { view: "outreach", label: "Outreach" },
  { view: "furniture", label: "Furniture" },
  { view: "services", label: "Social services" },
  { view: "distros", label: "Distros" },
  { view: "shifts", label: "Shifts" },
  { view: "dashboard", label: "Dashboard" },
  { view: "data", label: "Data tables" },
];

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Random, sortable-enough 20-char id for rows created on-device. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % 32];
  return out;
}

export function nowIso(clock?: () => Date): string {
  return (clock ? clock() : new Date()).toISOString();
}

/** Business date (YYYY-MM-DD) in the org's timezone, default America/New_York. */
export function localDate(iso: string, timeZone = "America/New_York"): string {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

export function fulfilledCountKey(date: string, typeKey: string): string {
  return `${date}|${typeKey}`;
}
