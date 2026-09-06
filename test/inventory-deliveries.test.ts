/** Inventory stock, delivery dispatch, and per-type expiry windows. */

import { describe, expect, it } from "vitest";
import {
  outOfStockTypes,
  recordInventoryCount,
  setStockLevel,
  stockFor,
} from "../src/domain/inventory.ts";
import {
  claimDelivery,
  completeDelivery,
  createDelivery,
  listDeliveries,
  releaseDelivery,
  DeliveryTakenError,
} from "../src/domain/deliveries.ts";
import { fulfill } from "../src/domain/checkin.ts";
import { buildOutreachList } from "../src/domain/outreach.ts";
import { expireStale } from "../src/domain/lifecycle.ts";
import { setItemPolicy } from "../src/domain/cooldowns.ts";
import { waitlistReport } from "../src/domain/reporting.ts";
import { localDate, nowIso } from "../src/schema.ts";
import { FIXED_NOW, daysAgo, freshStore, makeHousehold, makeRequest } from "./helpers.ts";

describe("inventory", () => {
  it("counts set stock, fulfill decrements, outreach skips OUT items", async () => {
    const store = await freshStore();
    const h1 = makeHousehold(store.base);
    const soapReq = makeRequest(store.base, h1.id, { type: "soap" });
    const h2 = makeHousehold(store.base);
    makeRequest(store.base, h2.id, { type: "clothing" });

    recordInventoryCount(
      store.base,
      { date: localDate(nowIso()), counts: { soap: 2, clothing: 0 } },
      { peerId: store.peerId, name: "counter" }
    );
    expect(stockFor(store.base.doc(), "soap")).toBe(2);
    expect(stockFor(store.base.doc(), "pads")).toBeNull(); // untracked
    expect([...outOfStockTypes(store.base.doc())]).toEqual(["clothing"]);

    // In-stock-only outreach: the clothing-only household disappears.
    const list = buildOutreachList(store.base.doc(), { inStockOnly: true });
    expect(list.map((c) => c.householdId)).toEqual([h1.id]);
    // Untracked items still reach out normally.
    const all = buildOutreachList(store.base.doc(), {});
    expect(all).toHaveLength(2);

    // Delivery walks stock out the door.
    fulfill(store.base, { requestIds: [soapReq.id], socialServiceRequestIds: [] });
    expect(stockFor(store.base.doc(), "soap")).toBe(1);

    // Waitlist shows the stock column.
    const rows = waitlistReport(store.base.doc(), localDate(nowIso()));
    expect(rows.find((r) => r.type === "clothing")?.stock).toBe(0);

    // Negative = stop tracking.
    setStockLevel(store.base, "soap", -1, { peerId: store.peerId });
    expect(stockFor(store.base.doc(), "soap")).toBeNull();
  });
});

describe("delivery dispatch", () => {
  it("post → claim → complete clears the household flag; double-claim rejected", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { needsDelivery: true });
    const task = createDelivery(
      store.distros!,
      { items: "2 bags clothing", householdId: h.id, address: "1 Test St" },
      store.peerId
    );
    expect(listDeliveries(store.distros!.doc())[0]!.status).toBe("Open");

    claimDelivery(store.distros!, task.id, { peerId: "aa".repeat(32), name: "Diego" });
    expect(() =>
      claimDelivery(store.distros!, task.id, { peerId: "bb".repeat(32), name: "Someone" })
    ).toThrow(DeliveryTakenError);

    releaseDelivery(store.distros!, task.id, "aa".repeat(32));
    expect(store.distros!.doc().deliveries![task.id]!.status).toBe("Open");

    claimDelivery(store.distros!, task.id, { peerId: "aa".repeat(32), name: "Diego" });
    completeDelivery(store.distros!, task.id);
    expect(store.distros!.doc().deliveries![task.id]!.status).toBe("Delivered");
  });
});

describe("per-type expiry windows", () => {
  it("itemPolicies.expiryDays overrides the catalog default", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    // 10 days old: default (14d) would keep it open; a 7-day policy expires it.
    const urgent = makeRequest(store.base, h.id, {
      type: "adult_diapers",
      requestOpenedAt: daysAgo(10),
    });
    // 20 days old: default would expire it; a 60-day policy keeps it.
    const patient = makeRequest(store.base, h.id, {
      type: "queen_mattress",
      requestOpenedAt: daysAgo(20),
    });
    setItemPolicy(store.base, "adult_diapers", { expiryDays: 7 });
    setItemPolicy(store.base, "queen_mattress", { expiryDays: 60 });

    const report = expireStale(store.base, FIXED_NOW);
    expect(report.timedOutRequestIds).toContain(urgent.id);
    expect(report.timedOutRequestIds).not.toContain(patient.id);
    expect(store.base.doc().requests[patient.id]!.status).toBe("Open");
  });
});
