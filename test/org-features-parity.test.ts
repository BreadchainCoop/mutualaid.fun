/**
 * CRDT parity for the org-features (per-item timeout + last-4 search +
 * outreach language routing) — mirrors the server tests over the Automerge doc.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import {
  timeout,
  searchByPhoneSuffix,
} from "../src/domain/checkin.ts";
import {
  assembleAllMessage,
  queueBlast,
  resolveSendLanguage,
  selectTemplate,
} from "../src/domain/outreach.ts";
import { MemorySigner } from "@automerge/automerge-subduction";
import { openStore } from "../src/store.ts";
import { freshStore, makeHousehold, makeRequest, memoryStorage } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

describe("org config with empty optional fields (Automerge undefined guard)", () => {
  it("creates an org without a short name without crashing", async () => {
    const store = await openStore({
      storage: memoryStorage(),
      endpoints: [],
      createOrg: "No Short Name Org",
      orgConfig: {
        name: "No Short Name Org",
        shortName: undefined,
        branding: { primaryColor: "#123456", themeColor: undefined, logo: "initials" },
      },
    });
    const cfg = store.base.doc().config!;
    expect(cfg.name).toBe("No Short Name Org");
    expect("shortName" in cfg).toBe(false); // undefined key stripped
    expect(cfg.branding!.primaryColor).toBe("#123456");
    expect("themeColor" in cfg.branding!).toBe(false);
  });
});

const ES = "Español / Spanish / 西班牙语";
const EN = "Inglés / English / 英文";
const MANDARIN = "Chino Mandarín / Mandarin / 普通话";
const CANTONESE = "Chino Cantonés / Cantonese / 广东话";
const TOISHANESE = "Chino Toishanés / Toishanese / 台山话";
const QUECHUA = "Quechua el dialecto / Quechua Dialect / 克丘亞語";

describe("per-item timeout at check-in", () => {
  it("times out an OPEN declined item without feeding fulfilled counts", async () => {
    const store = await freshStore();
    const hh = makeHousehold(store.base);
    const r = makeRequest(store.base, hh.id, { type: "soap", status: "Open" });
    const [out] = timeout(store.base, { requestIds: [r.id] });
    expect(out.status).toBe("Timeout");
    expect(out.processingDate).toBeDefined();
    expect(Object.keys(store.base.doc().fulfilledCounts)).toHaveLength(0);
  });

  it("leaves a Delivered request untouched", async () => {
    const store = await freshStore();
    const hh = makeHousehold(store.base);
    const r = makeRequest(store.base, hh.id, { type: "soap", status: "Delivered" });
    timeout(store.base, { requestIds: [r.id] });
    expect(store.base.doc().requests[r.id]!.status).toBe("Delivered");
  });

  it("throws on an unknown id", async () => {
    const store = await freshStore();
    expect(() => timeout(store.base, { requestIds: ["nope"] })).toThrow(/Unknown ids/);
  });
});

describe("last-4-digits phone search", () => {
  it("matches households by trailing digits, ignoring non-digits", async () => {
    const store = await freshStore();
    const a = makeHousehold(store.base, { name: "Aa", phoneNumber: "+17185550142" });
    makeHousehold(store.base, { name: "Bb", phoneNumber: "+12125559142" });
    expect(searchByPhoneSuffix(store.base.doc(), "0142").map((h) => h.id)).toEqual([a.id]);
    expect(searchByPhoneSuffix(store.base.doc(), "(0142)").map((h) => h.id)).toEqual([a.id]);
    expect(searchByPhoneSuffix(store.base.doc(), "")).toEqual([]);
  });
});

describe("outreach language routing", () => {
  it("resolves the send-language per the org rules", () => {
    expect(resolveSendLanguage([ES])).toBe("Spanish");
    expect(resolveSendLanguage([QUECHUA])).toBe("Spanish");
    expect(resolveSendLanguage([MANDARIN])).toBe("Cantonese");
    expect(resolveSendLanguage([CANTONESE])).toBe("Cantonese");
    expect(resolveSendLanguage([EN])).toBe("English");
    expect(resolveSendLanguage([EN, ES])).toBe("Spanish");
    expect(resolveSendLanguage([TOISHANESE])).toBe("All");
    expect(resolveSendLanguage([])).toBe("All");
  });

  it("assembles the All message in Spanish, Cantonese, English order", () => {
    expect(assembleAllMessage({ Spanish: "ES", Cantonese: "YUE", English: "EN" })).toBe("ES\n\nYUE\n\nEN");
    expect(assembleAllMessage({ English: "EN", Spanish: "ES" })).toBe("ES\n\nEN");
  });

  it("selectTemplate: direct hit, and All fallback when the language has no text", () => {
    const t = { Spanish: "ES", Cantonese: "YUE", English: "EN" };
    expect(selectTemplate(t, [QUECHUA])).toBe("ES");
    expect(selectTemplate(t, [TOISHANESE])).toBe("ES\n\nYUE\n\nEN");
    expect(selectTemplate({ Spanish: "ES", English: "EN" }, [CANTONESE])).toBe("ES\n\nEN");
  });

  it("queueBlast routes each household to its language body", async () => {
    const store = await freshStore();
    const es = makeHousehold(store.base, { name: "Rosa", phoneNumber: "+17185550001", languages: [ES] });
    const yue = makeHousehold(store.base, { name: "Wei", phoneNumber: "+17185550002", languages: [MANDARIN] });
    const all = makeHousehold(store.base, { name: "Toi", phoneNumber: "+17185550003", languages: [TOISHANESE] });
    const report = queueBlast(store.base, {
      householdIds: [es.id, yue.id, all.id],
      template: "",
      templates: { Spanish: "Hola [FIRST_NAME]", Cantonese: "YUE msg", English: "EN msg" },
      tokenFactory: () => "tok",
    });
    const byId = Object.fromEntries(report.messages.map((m) => [m.householdId, m.body]));
    expect(byId[es.id]).toBe("Hola Rosa");
    expect(byId[yue.id]).toBe("YUE msg");
    expect(byId[all.id]).toBe("Hola Toi\n\nYUE msg\n\nEN msg");
  });

  it("scalar template still goes to everyone (back-compat)", async () => {
    const store = await freshStore();
    const hh = makeHousehold(store.base, { name: "Ana", phoneNumber: "+17185550009", languages: [MANDARIN] });
    const report = queueBlast(store.base, {
      householdIds: [hh.id],
      template: "One [FIRST_NAME]",
      tokenFactory: () => "tok",
    });
    expect(report.messages[0]!.body).toBe("One Ana");
  });
});
