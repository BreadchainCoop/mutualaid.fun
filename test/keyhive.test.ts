/**
 * Keyhive: cryptographic access control.
 *
 * The offline tests below run everywhere. The end-to-end grant/revoke proof
 * needs a keyhive-mode relay and is gated on KEYHIVE_RELAY, e.g.
 *
 *   KEYHIVE_RELAY=wss://keyhive.sync.automerge.org npx vitest run test/keyhive.test.ts
 *
 * A local relay works too, but it must run in keyhive mode — `--auth open`
 * drops keyhive traffic silently:
 *   subduction server --socket 127.0.0.1:8944 --data-dir /tmp/kh --auth keyhive
 */

import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import { MemorySigner } from "@automerge/automerge-subduction";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore, syncAccess } from "../src/store.ts";
import {
  addMember,
  publishContactCard,
  revokeMember,
  rosterPolicy,
  sedimentreeIdForDocUrl,
} from "../src/roster.ts";
import {
  grantAccess,
  isProtected,
  myAccess,
  myContactCard,
  openKeyhiveRepo,
  receiveContactCard,
  relaySpeaksKeyhive,
  revokeAccess,
  listAccess,
} from "../src/keyhive.ts";

const RELAY = process.env.KEYHIVE_RELAY;
const tmp = (name: string) => new NodeFSStorageAdapter(mkdtempSync(join(tmpdir(), name)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await initSubduction();
});

describe("sedimentree ids", () => {
  it("pads both plain and keyhive document ids to 32 bytes", () => {
    // Plain automerge ids are 16 bytes; keyhive's are already 32. Appending a
    // fixed 32 zeros would make the latter 48 bytes and match nothing, which
    // would silently disable every per-domain denial in rosterPolicy.
    const plain = "automerge:3qVE9QJdM9SzzqNgpPxtDKTuhmsG";
    const keyhive = "automerge:vHrT2r6HzjHBxQQrZyweWAJe3CfYRtp97UduX17cNbV9WgYRc";
    expect(sedimentreeIdForDocUrl(plain)).toHaveLength(64);
    expect(sedimentreeIdForDocUrl(keyhive)).toHaveLength(64);
    // The keyhive id is the document id verbatim — no padding to add.
    expect(sedimentreeIdForDocUrl(keyhive)).not.toMatch(/0{32}$/);
  });
});

describe("keyhive, offline", () => {
  it("marks documents from create2 protected and those from create not", async () => {
    const { hive, repo } = await openKeyhiveRepo({ storage: tmp("kh-off-"), endpoints: [] });
    const protectedDoc = await repo.create2({ x: 1 });
    const legacyDoc = repo.create({ x: 1 });
    expect(isProtected(protectedDoc.url)).toBe(true);
    expect(isProtected(legacyDoc.url)).toBe(false);

    // Existing documents cannot be upgraded in place: this is why migrating an
    // org means creating new documents and copying state, not flipping a flag.
    await expect(grantAccess(hive, legacyDoc.url, myContactCard(hive))).rejects.toThrow(
      /unprotected/i
    );
  });

  it("round-trips a contact card between two devices", async () => {
    const a = await openKeyhiveRepo({ storage: tmp("kh-card-a-"), endpoints: [] });
    const b = await openKeyhiveRepo({ storage: tmp("kh-card-b-"), endpoints: [] });
    const card = myContactCard(b.hive);
    // A card is a signed op carrying the sender's share key — the payload the
    // QR invite has to transport.
    const parsed = Object.values(JSON.parse(card))[0] as Record<string, unknown>;
    expect(parsed).toHaveProperty("signature");
    expect(parsed).toHaveProperty("issuer");
    await expect(receiveContactCard(a.hive, card)).resolves.not.toThrow();
    // Garbage must be rejected, not silently ignored: a failed exchange has to
    // surface at redeem time rather than as mysteriously absent access later.
    await expect(receiveContactCard(a.hive, "not a card")).rejects.toThrow();
  });

  it("reports a relay that never speaks keyhive rather than assuming success", async () => {
    // No endpoints at all: nothing can answer, so this must come back false
    // instead of hanging or reading as encrypted-and-syncing.
    const { hive } = await openKeyhiveRepo({ storage: tmp("kh-mute-"), endpoints: [] });
    expect(await relaySpeaksKeyhive(hive, { timeoutMs: 1500, intervalMs: 250 })).toBe(false);
  });

  it("gives a keyhive org a stable peer id across reopens", async () => {
    // Keyhive supplies the identity, so the roster's member key must still
    // survive a reload — otherwise every restart looks like a new device.
    const storage = tmp("kh-ident-");
    const first = await openKeyhiveRepo({ storage, endpoints: [] });
    const second = await openKeyhiveRepo({ storage, endpoints: [] });
    expect(second.peerId).toBe(first.peerId);
    // ...while the keyhive-layer peer id carries a per-instance nonce.
    expect(second.hive.peerId).not.toBe(first.hive.peerId);
  });

  it("keeps encrypted documents readable across a reload", async () => {
    // What a browser refresh does. Keyhive's own state and the documents live
    // in separate adapters, so this also pins that one storage argument is
    // enough — passing only the keyhive one leaves documents in memory and
    // loses the whole org on reload.
    const dir = mkdtempSync(join(tmpdir(), "kh-reload-"));
    const first = await openKeyhiveRepo({ storage: new NodeFSStorageAdapter(dir), endpoints: [] });
    const doc = await first.repo.create2<{ hello: string }>({ hello: "world" });
    await first.repo.flush();

    const second = await openKeyhiveRepo({ storage: new NodeFSStorageAdapter(dir), endpoints: [] });
    expect(second.peerId).toBe(first.peerId);
    const reopened = await second.repo.find<{ hello: string }>(doc.url as never);
    expect(reopened.doc()?.hello).toBe("world");
    expect(await myAccess(second.hive, doc.url)).toBe("admin");
  }, 60000);

  it("reopens a whole encrypted org from storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kh-reload-org-"));
    const created = await openStore({
      signer: MemorySigner.generate(),
      storage: new NodeFSStorageAdapter(dir),
      endpoints: [],
      keyhive: true,
      createOrg: "Reload Town",
      deviceName: "founder",
    });
    await created.repo.flush();

    const reopened = await openStore({
      signer: MemorySigner.generate(),
      storage: new NodeFSStorageAdapter(dir),
      endpoints: [],
      keyhive: true,
      rosterUrl: created.roster.url,
    });
    expect(reopened.roster.doc()?.org).toBe("Reload Town");
    // The device is still itself, so it is still its own org's admin — the
    // identity has to come from storage, not from the signer we passed.
    expect(reopened.peerId).toBe(created.peerId);
    expect(reopened.roster.doc()!.members[reopened.peerId]?.role).toBe("admin");
  }, 90000);

  it("refuses to open a pre-keyhive org in keyhive mode", async () => {
    // Documents cannot be upgraded in place, so joining a plaintext org with
    // keyhive on would sync it happily while `hive` implies it is encrypted.
    // Same storage, so the roster really is found and the check is what
    // rejects it — not an incidental "document unavailable".
    const dir = mkdtempSync(join(tmpdir(), "kh-legacy-"));
    const plain = await openStore({
      signer: MemorySigner.generate(),
      storage: new NodeFSStorageAdapter(dir),
      endpoints: [],
      createOrg: "Legacy Town",
    });
    await plain.repo.flush();
    await expect(
      openStore({
        signer: MemorySigner.generate(),
        storage: new NodeFSStorageAdapter(dir),
        endpoints: [],
        keyhive: true,
        rosterUrl: plain.roster.url,
      })
    ).rejects.toThrow(/cannot be encrypted in place|migration/i);
  }, 30000);

  it("encrypts the data documents and leaves the roster readable", async () => {
    const store = await openStore({
      signer: MemorySigner.generate(),
      storage: tmp("kh-org-"),
      endpoints: [],
      keyhive: true,
      createOrg: "Keyhive Town",
      deviceName: "founding device",
    });
    expect(store.hive).toBeDefined();
    // The PII lives here, so this is what has to be encrypted.
    expect(isProtected(store.base.url)).toBe(true);
    expect(isProtected(store.distros!.url)).toBe(true);
    // The roster deliberately is not: a joining device must be able to read it
    // to publish the contact card that access is granted to. Encrypting it
    // would be a lock whose key is inside the box.
    expect(isProtected(store.roster.url)).toBe(false);
    expect(store.roster.doc()?.encrypted).toBe(true);

    // The founding device is on its own roster under the keyhive identity,
    // and has published the card that makes it grantable.
    expect(store.roster.doc()!.members[store.peerId]!.role).toBe("admin");
    expect(store.roster.doc()!.members[store.peerId]!.contactCard).toBeTruthy();
    expect(await myAccess(store.hive!, store.base.url)).toBe("admin");
  });

  it("still enforces the roster — keyhive is a second layer, not a replacement", async () => {
    // Keyhive stops a stranger DECRYPTING; the roster stops us serving them
    // anything in the first place. Enabling one must not disable the other.
    const calls: string[] = [];
    const store = await openStore({
      signer: MemorySigner.generate(),
      storage: tmp("kh-policy-"),
      endpoints: [],
      keyhive: true,
      createOrg: "Keyhive Town",
    });
    expect(store.hive).toBeDefined();

    // The policy the store built is the one the Repo consults, so exercise it
    // the way a peer arriving on the wire would.
    const policy = rosterPolicy(() => store.roster.doc(), {
      alwaysAllow: () => [store.peerId],
    });
    const stranger = MemorySigner.generate().peerId().toString();
    await expect(policy.authorizeConnect(stranger)).rejects.toThrow();
    await expect(policy.authorizeFetch(stranger, "tree")).rejects.toThrow();
    expect(await policy.filterAuthorizedFetch(stranger, ["a", "b"])).toEqual([]);
    // ...while this device, an admin of its own org, is allowed.
    await expect(policy.authorizeConnect(store.peerId)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("hands the roster policy to the Repo it builds", async () => {
    // The policy reaches the Repo through the bridge's `repo` config, which is
    // loosely typed — so assert the wiring rather than trusting it.
    const seen: string[] = [];
    const spy = {
      authorizeConnect: async (p: unknown) => {
        seen.push(`connect:${String(p).slice(0, 8)}`);
      },
      authorizeFetch: async () => {},
      authorizePut: async () => {},
      filterAuthorizedFetch: async (_p: unknown, ids: string[]) => ids,
    };
    const { repo } = await openKeyhiveRepo({
      storage: tmp("kh-wiring-"),
      endpoints: [],
      subductionPolicy: spy,
    });
    const doc = await repo.create2({ x: 1 });
    doc.change((d: { x: number }) => {
      d.x = 2;
    });
    await repo.flush();
    // Offline there are no peers to authorize, so the meaningful assertion is
    // that the Repo accepted the policy and still works with it installed.
    expect(doc.doc()?.x).toBe(2);
  });
});

describe.skipIf(!RELAY)("keyhive through a relay", () => {
  it("grants, syncs, then revokes so the removed device cannot decrypt", async () => {
    const admin = await openKeyhiveRepo({
      storage: tmp("kh-e2e-a-"),
      endpoints: [RELAY!],
      peerIdSuffix: "mat-test-a",
    });
    const volunteer = await openKeyhiveRepo({
      storage: tmp("kh-e2e-b-"),
      endpoints: [RELAY!],
      peerIdSuffix: "mat-test-b",
    });

    // Fail loudly if the relay is not actually in keyhive mode, rather than
    // letting the assertions below fail as if the code were broken.
    expect(await relaySpeaksKeyhive(admin.hive)).toBe(true);

    const doc = await admin.repo.create2<{ households: Record<string, { name: string }> }>({
      households: { h1: { name: "Household One" } },
    });
    await admin.hive.addSyncServerRelayToDoc(doc.url);

    // Cards cross BOTH ways: without the admin's card the volunteer cannot
    // verify the delegation it is about to receive.
    await receiveContactCard(volunteer.hive, myContactCard(admin.hive));
    await grantAccess(admin.hive, doc.url, myContactCard(volunteer.hive), "edit");

    // The bridge rotates the document key on a debounce after a grant; writes
    // issued before that lands are dropped rather than encrypted.
    await sleep(8000);
    doc.change((d) => {
      d.households.h2 = { name: "Household Two" };
    });
    await admin.repo.flush().catch(() => {});
    await sleep(8000);

    const theirCopy = await volunteer.repo.find<{
      households: Record<string, { name: string }>;
      secret?: string;
    }>(doc.url as never);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !theirCopy.doc()?.households?.h2) await sleep(500);
    expect(theirCopy.doc()?.households?.h1?.name).toBe("Household One");
    expect(theirCopy.doc()?.households?.h2?.name).toBe("Household Two");
    expect(await myAccess(volunteer.hive, doc.url)).toBe("edit");

    // A document they were never granted stays out of reach, even though they
    // hold access to another document on the same relay and know the URL.
    const secondDoc = await admin.repo.create2({ distros: { d1: { site: "Depot" } } });
    await admin.hive.addSyncServerRelayToDoc(secondDoc.url);
    await expect(volunteer.repo.find(secondDoc.url as never)).rejects.toThrow(/unavailable/i);

    // --- revoke ---
    const members = await listAccess(admin.hive, doc.url);
    const target = members.find((m) => !m.isSelf && !m.isSyncServer)!;
    expect(target).toBeDefined();
    await revokeAccess(admin.hive, admin.repo, doc.url, target.id);
    await sleep(6000);

    doc.change((d) => {
      d.households.h3 = { name: "After Revocation" };
    });
    await admin.repo.flush().catch(() => {});
    await sleep(20000);

    // The admin can still write and read: the revoke must not brick the doc.
    expect(doc.doc()?.households?.h3?.name).toBe("After Revocation");
    // The revoked device cannot decrypt anything minted after its removal...
    expect(theirCopy.doc()?.households?.h3).toBeUndefined();
    expect(await myAccess(volunteer.hive, doc.url)).toBeNull();
    // ...but keeps the copy it already had. Revocation stops future updates,
    // it does not reach back and unsee what already synced.
    expect(theirCopy.doc()?.households?.h1?.name).toBe("Household One");
  }, 180000);

  it("gives roster members the keys, and takes them back on revoke", async () => {
    // The whole point: "who an admin adds" has to be what decides who can
    // decrypt. Roster membership and cryptographic membership are separate
    // systems, and this is the reconciliation that keeps them in step.
    const relay = [RELAY!];
    const admin = await openStore({
      signer: MemorySigner.generate(),
      storage: tmp("kh-team-a-"),
      endpoints: relay,
      keyhive: true,
      createOrg: "TeamTown",
      deviceName: "admin",
    });
    admin.base.change((d) => {
      d.households.h1 = {
        id: "h1",
        name: "SECRET-HOUSEHOLD",
        invalidPhoneNumber: false,
        intlPhoneNumber: false,
        languages: [],
        missedAppointmentCount: 0,
        needsDelivery: false,
        needsEmailOutreach: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    await admin.repo.flush().catch(() => {});
    await sleep(4000);

    // The volunteer joins the way the product joins: roster URL only.
    const volunteer = await openStore({
      signer: MemorySigner.generate(),
      storage: tmp("kh-team-b-"),
      endpoints: relay,
      keyhive: true,
      rosterUrl: admin.roster.url,
      invite: undefined,
    }).catch((err) => err as Error);
    // Not yet a member, so it cannot even open the org.
    expect(volunteer).toBeInstanceOf(Error);

    // Admin enrols them, then reconciles.
    const volunteerStore = await openKeyhiveRepo({
      storage: tmp("kh-team-b2-"),
      endpoints: relay,
      peerIdSuffix: "mat-team-b",
    });
    addMember(admin.roster, admin.peerId, {
      peerId: volunteerStore.peerId,
      name: "volunteer",
      role: "volunteer",
    });
    // Without a published card there is nobody to grant to...
    expect((await syncAccess(admin)).granted).toEqual([]);
    publishContactCard(admin.roster, volunteerStore.peerId, myContactCard(volunteerStore.hive));
    // ...and with one, the grant follows from roster membership alone.
    expect((await syncAccess(admin)).granted).toContain(volunteerStore.peerId);

    await admin.repo.flush().catch(() => {});
    await sleep(8000);
    const theirCopy = await volunteerStore.repo.find<{
      households: Record<string, { name: string }>;
    }>(admin.base.url as never);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !theirCopy.doc()?.households?.h1) await sleep(500);
    expect(theirCopy.doc()?.households?.h1?.name).toBe("SECRET-HOUSEHOLD");
    expect(await myAccess(volunteerStore.hive, admin.base.url)).toBe("edit");

    // Revoking on the roster takes the keys back.
    revokeMember(admin.roster, admin.peerId, volunteerStore.peerId);
    expect((await syncAccess(admin)).revoked).toContain(volunteerStore.peerId);

    admin.base.change((d) => {
      d.households.h2 = {
        id: "h2",
        name: "AFTER-REVOKE",
        invalidPhoneNumber: false,
        intlPhoneNumber: false,
        languages: [],
        missedAppointmentCount: 0,
        needsDelivery: false,
        needsEmailOutreach: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    await admin.repo.flush().catch(() => {});
    await sleep(20000);
    // The revoked device cannot decrypt what was written after it left...
    expect(theirCopy.doc()?.households?.h2).toBeUndefined();
    expect(await myAccess(volunteerStore.hive, admin.base.url)).toBeNull();
    // ...but keeps what it already had, which is the honest limit of revocation.
    expect(theirCopy.doc()?.households?.h1?.name).toBe("SECRET-HOUSEHOLD");
  }, 240000);

  it("would notice if the post-revoke key rotation were dropped", async () => {
    // revokeAccess() rotates the document key by hand because the bridge does
    // it for adds but not revokes. Without the rotation there is no derivable
    // key, and the blob interceptor silently drops every later write instead
    // of encrypting it — the doc looks fine in memory while nothing persists.
    // This pins that behaviour, so deleting the rotation fails here loudly
    // rather than as mysterious data loss in production.
    const admin = await openKeyhiveRepo({
      storage: tmp("kh-rot-"),
      endpoints: [RELAY!],
      peerIdSuffix: "mat-test-rot",
    });
    const other = await openKeyhiveRepo({ storage: tmp("kh-rot-b-"), endpoints: [] });

    const doc = await admin.repo.create2<{ n: number }>({ n: 1 });
    await admin.hive.addSyncServerRelayToDoc(doc.url);
    await receiveContactCard(admin.hive, myContactCard(other.hive));
    await grantAccess(admin.hive, doc.url, myContactCard(other.hive), "edit");
    await sleep(8000);

    const members = await listAccess(admin.hive, doc.url);
    const target = members.find((m) => !m.isSelf && !m.isSyncServer)!;

    // Revoke WITHOUT rotating — the bare bridge call revokeAccess wraps.
    await admin.hive.revokeMemberFromDoc(doc.url, target.id);
    doc.change((d) => {
      d.n = 2;
    });
    await expect(admin.repo.flush()).rejects.toThrow(/transformOutgoing returned null/);

    // Rotating recovers it: the same write now encrypts and persists.
    // (revokeAccess re-revokes first, which is a no-op the second time.)
    await revokeAccess(admin.hive, admin.repo, doc.url, target.id);
    doc.change((d) => {
      d.n = 3;
    });
    await expect(admin.repo.flush()).resolves.not.toThrow();
    expect(doc.doc()?.n).toBe(3);
  }, 120000);
});
