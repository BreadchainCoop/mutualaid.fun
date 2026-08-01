/** Encrypted checkpoints: round-trip, wrong-passphrase rejection, restore. */

import { describe, expect, it } from "vitest";
import { Repo } from "@automerge/automerge-repo";
import {
  createCheckpoint,
  decryptCheckpoint,
  readCheckpointDocs,
  restoreInto,
} from "../src/checkpoint.ts";
import { openStore } from "../src/store.ts";
import { isProtected } from "../src/keyhive.ts";
import { freshStore, makeHousehold, makeRequest, memoryStorage } from "./helpers.ts";

describe("encrypted checkpoints", () => {
  it("round-trips the whole org and restores it into a fresh repo", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { name: "Ckpt Test" });
    makeRequest(store.base, h.id, { type: "soap" });

    const { bytes, header } = await createCheckpoint(store, "correct horse battery");
    expect(header.docs.map((d) => d.key)).toContain("roster");
    expect(header.docs.map((d) => d.key)).toContain("base");
    expect(header.docs.map((d) => d.key)).toContain("distros");
    // Ciphertext must not leak plaintext (name should not appear raw).
    const asText = new TextDecoder().decode(bytes);
    expect(asText).not.toContain("Ckpt Test");

    const { docs } = await decryptCheckpoint(bytes, "correct horse battery");
    const snapshot = readCheckpointDocs(new Repo({}), docs);
    // A restore builds a NEW org and pours the backup into it, so the restored
    // documents are encrypted like any other — re-importing the old binaries
    // could only ever produce unencrypted ones.
    const restored = await openStore({
      storage: memoryStorage(),
      endpoints: [],
      createOrg: snapshot.roster.org,
      deviceName: "laptop",
    });
    restoreInto(restored, snapshot);

    const households = Object.values(restored.base.doc()!.households);
    expect(households.some((x) => x.name === "Ckpt Test")).toBe(true);
    // The restoring device holds the org, and the data is encrypted.
    expect(restored.roster.doc()!.members[restored.peerId]?.role).toBe("admin");
    expect(isProtected(restored.base.url)).toBe(true);
    expect(restored.base.url).not.toBe(store.base.url);
    expect(restored.distros!.url).not.toBe(store.distros!.url);
  });

  it("rejects a wrong passphrase and garbage files", async () => {
    const store = await freshStore();
    const { bytes } = await createCheckpoint(store, "right passphrase");
    await expect(decryptCheckpoint(bytes, "wrong passphrase")).rejects.toThrow(/passphrase/i);
    await expect(
      decryptCheckpoint(new TextEncoder().encode("not a checkpoint at all"), "x")
    ).rejects.toThrow(/isn't a checkpoint/i);
    await expect(createCheckpoint(store, "short")).rejects.toThrow(/8 characters/);
  });
});
