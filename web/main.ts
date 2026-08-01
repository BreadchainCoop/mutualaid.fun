/**
 * Browser entry: device identity, org create/join, then boot the operator
 * console (copied verbatim from bam/web) on the CRDT-backed api adapter.
 *
 * Boot order matters: the console's app.js and views are classic IIFE
 * scripts expecting window.BAM; we set BAM.api (the adapter) and
 * BAM.LANGUAGES first, inject the scripts in order, register the extra
 * Roster view, then call BAM.start().
 */

import { Repo, initSubduction } from "@automerge/automerge-repo";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { DEFAULT_SYNC_ENDPOINT, openStore, syncAccess, type BamStore } from "../src/store.ts";
import { openKeyhiveRepo } from "../src/keyhive.ts";
import { decryptCheckpoint, fetchFromIpfs, readCheckpointDocs, restoreInto } from "../src/checkpoint.ts";
import { rosterPolicy } from "../src/roster.ts";
import type { RosterDoc } from "../src/schema.ts";
import {
  hasCap,
  isAdmin,
  parseInviteUrl,
  reinstateMember,
  revokeMember,
  setCap,
  setDomainGrant,
  setViewGrant,
  touchLastSeen,
  viewAllowed,
  type InvitePayload,
} from "../src/roster.ts";
import { DEVICE_VIEWS } from "../src/schema.ts";
import { makeWebApi } from "../src/webapi.ts";
import { registerRosterView } from "../src/roster-view.ts";
import { registerSettingsView } from "../src/settings-view.ts";
import { LANGUAGES } from "../src/domain/catalog.ts";

// Console assets inlined at build time (?raw) so the app is one bundle.
import consoleFonts from "./console/fonts.css?raw";
import consoleStyles from "./console/styles.css?raw";
import consoleApp from "./console/app.js?raw";
import viewHome from "./console/views/home.js?raw";
import viewCheckin from "./console/views/checkin.js?raw";
import viewAppointments from "./console/views/appointments.js?raw";
import viewLookup from "./console/views/lookup.js?raw";
import viewDashboard from "./console/views/dashboard.js?raw";
import viewIntake from "./console/views/intake.js?raw";
import viewOutreach from "./console/views/outreach.js?raw";
import viewFurniture from "./console/views/furniture.js?raw";
import viewServices from "./console/views/services.js?raw";
import viewDistros from "./console/views/distros.js?raw";
import viewShifts from "./console/views/shifts.js?raw";
import viewData from "./console/views/data.js?raw";
import viewAdmin from "./console/views/admin.js?raw";

// Apply the console fonts + stylesheet (index.html no longer links them).
{
  const fonts = document.createElement("style");
  fonts.textContent = consoleFonts;
  document.head.append(fonts);
  const style = document.createElement("style");
  style.textContent = consoleStyles;
  document.head.append(style);
}

interface AppConfig {
  mode: "create" | "join";
  orgName?: string;
  rosterUrl?: string;
  endpoint?: string;
  relayPeer?: string;
  /** This device's display name on the roster (the founding admin, at create). */
  deviceName?: string;
  /** White-label config captured at org creation, baked into the CRDT doc. */
  orgConfig?: {
    name: string;
    shortName?: string;
    branding?: { primaryColor?: string; themeColor?: string; title?: string; logo?: string };
  };
}

const CONFIG_KEY = "bam-local-first-config";

function loadConfig(): AppConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as AppConfig) : null;
  } catch {
    return null;
  }
}

function saveConfig(config: AppConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

/** First-run screen: create a new org or join one by roster URL. */
function firstRunScreen(root: HTMLElement, peerId: string): Promise<AppConfig> {
  return new Promise((resolve) => {
    root.innerHTML = "";
    const wrap = el("div", { class: "boot-onboard" });

    // Hero: the Bread voice up top, then two clear paths (create / join).
    const hero = el("div", { class: "boot-hero" });
    const title = el("h2", { class: "boot-hero__title" });
    title.innerHTML = "Your tools. Your data. <em>Your rules.</em>";
    const sub = el(
      "p",
      { class: "boot-hero__sub muted" },
      "This runs on your device — no company in the middle, works offline, and " +
        "your community's data stays with you. Start your own, or join one you were invited to."
    );
    hero.append(title, sub);

    // Labelled field helper: wires <label for> to the control for a11y.
    let idc = 0;
    const field = (labelText: string, input: HTMLElement, hint?: string): HTMLElement => {
      const f = el("div", { class: "field" });
      if (!input.id) input.id = `boot-f${++idc}`;
      f.append(el("label", { class: "label", for: input.id }, labelText), input);
      if (hint) f.append(el("div", { class: "list-item__meta" }, hint));
      return f;
    };

    const orgName = el("input", { class: "input", placeholder: "e.g. Anytown Mutual Aid" });
    const shortName = el("input", { class: "input", placeholder: "e.g. AMA" });
    const brandColor = el("input", { class: "input", type: "color", value: "#ea5817" }) as HTMLInputElement;
    const logoSelect = el("select", { class: "input" }) as HTMLSelectElement;
    for (const [val, label] of [["loaf", "Bread mark"], ["initials", "Initials chip"], ["none", "No logo"]]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      logoSelect.append(opt);
    }
    const deviceName = el("input", { class: "input", placeholder: "e.g. Rosa — laptop" });
    const createEndpoint = el("input", { class: "input", value: DEFAULT_SYNC_ENDPOINT }) as HTMLInputElement;
    const createBtn = el("button", { class: "btn btn-primary btn-block" }, "Create a new org on this device");

    const rosterUrl = el("input", { class: "input", placeholder: "automerge:…" });
    const endpoint = el("input", { class: "input", value: DEFAULT_SYNC_ENDPOINT }) as HTMLInputElement;
    const relayPeer = el("input", { class: "input", placeholder: "64-hex relay key — optional" });
    const joinBtn = el("button", { class: "btn btn-secondary btn-block" }, "Join an existing org");

    createBtn.onclick = () => {
      const name = orgName.value.trim() || "My Mutual Aid";
      const endpointValue = createEndpoint.value.trim() || undefined;
      resolve({
        mode: "create",
        orgName: name,
        deviceName: deviceName.value.trim() || undefined,
        // TOFU applies when an endpoint is set with no pinned relay key.
        endpoint: endpointValue,
        orgConfig: {
          name,
          shortName: shortName.value.trim() || undefined,
          branding: {
            primaryColor: brandColor.value,
            themeColor: brandColor.value,
            title: name,
            logo: logoSelect.value,
          },
        },
      });
    };
    joinBtn.onclick = () => {
      if (!rosterUrl.value.trim().startsWith("automerge:")) {
        alertText("A roster link starting with automerge: is required to join.");
        return;
      }
      resolve({
        mode: "join",
        rosterUrl: rosterUrl.value.trim(),
        endpoint: endpoint.value.trim() || undefined,
        relayPeer: relayPeer.value.trim() || undefined,
      });
    };

    const alertBox = el("div", { class: "list-item__meta", style: "color:var(--danger)" });
    function alertText(msg: string): void {
      alertBox.textContent = msg;
    }

    // Brand colour swatch + logo select share one row under a single label.
    const brandRow = el("div", { class: "brand-row" });
    brandRow.append(brandColor, logoSelect);
    if (!brandColor.id) brandColor.id = `boot-f${++idc}`;
    const brandField = el("div", { class: "field" });
    brandField.append(el("label", { class: "label", for: brandColor.id }, "Brand color & logo"), brandRow);

    // Advanced disclosure: swap in your own relay or go offline-only. The
    // maintainers' community relay is the default (set on createEndpoint).
    const createAdvanced = el("details", { class: "advanced" });
    createAdvanced.append(
      el("summary", {}, "Advanced: sync relay"),
      field(
        "Sync relay",
        createEndpoint,
        "Your team syncs through this relay. Point it at your own relay for sensitive data, or clear it to keep this org on this device only."
      )
    );

    const createCard = el("div", { class: "card stack" });
    createCard.append(
      el("h3", { class: "card__title" }, "Start your community"),
      el("p", { class: "muted card__lede" }, "Spin up a new org on this device — you'll be its founding admin."),
      field("Community name", orgName),
      field("Short name / initials", shortName),
      brandField,
      field("Your device name", deviceName),
      el(
        "div",
        { class: "list-item__meta", style: "margin-top:2px" },
        "Your team syncs through the community relay, so you can invite people right away. Name, colors, logo and tools are all editable later in Settings."
      ),
      createAdvanced,
      createBtn
    );

    // Join defaults to the community relay too; Advanced lets you match the
    // org's own relay + pin its key.
    const joinAdvanced = el("details", { class: "advanced" });
    joinAdvanced.append(
      el("summary", {}, "Advanced: sync relay"),
      field("Sync relay", endpoint, "Defaults to the community relay. Use the same relay the org's admin uses."),
      field("Relay key", relayPeer, "Leave blank to trust the relay on first connect.")
    );

    const joinCard = el("div", { class: "card stack" });
    joinCard.append(
      el("h3", { class: "card__title" }, "Join an existing one"),
      el("p", { class: "muted card__lede" }, "Have a roster link from an admin? Enter it to add this device."),
      field("Roster link", rosterUrl),
      el(
        "div",
        { class: "list-item__meta", style: "margin-top:2px" },
        "Joins through the community relay by default. If the org runs its own relay, set it under Advanced."
      ),
      joinAdvanced,
      joinBtn,
      alertBox
    );

    // Device key: quiet footer note, the key on its own line with a copy button.
    const keynote = el("div", { class: "keynote" });
    keynote.append(
      el("div", { class: "label" }, "This device's key"),
      el(
        "p",
        { class: "muted", style: "margin:2px 0 0;font-size:13px" },
        "Share this with an admin so they can add your device to their org."
      )
    );
    const keyRow = el("div", { class: "keynote__row" });
    const keyCode = el("code", { class: "mono keynote__key" }, peerId);
    const copyBtn = el("button", { class: "btn btn-ghost", type: "button" }, "Copy") as HTMLButtonElement;
    copyBtn.onclick = () => {
      navigator.clipboard?.writeText(peerId).then(
        () => {
          copyBtn.textContent = "Copied";
          window.setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
        },
        () => {}
      );
    };
    keyRow.append(keyCode, copyBtn);
    keynote.append(keyRow);

    // Restore from an encrypted checkpoint (Admin → Backups made it): a file
    // or an IPFS CID + the passphrase. Recovers the whole org onto this
    // device; teammates rejoin via a fresh roster link afterwards.
    const restoreFile = el("input", { class: "input", type: "file", accept: ".matckpt" }) as HTMLInputElement;
    const restoreCid = el("input", { class: "input", placeholder: "…or paste an IPFS CID" }) as HTMLInputElement;
    const restorePass = el("input", {
      class: "input",
      type: "password",
      placeholder: "Backup passphrase",
      autocomplete: "off",
    }) as HTMLInputElement;
    const restoreMsg = el("div", { class: "list-item__meta", style: "color:var(--danger)" });
    const restoreBtn = el("button", { class: "btn btn-secondary btn-block" }, "Restore this org") as HTMLButtonElement;
    restoreBtn.onclick = async () => {
      restoreMsg.textContent = "";
      const file = restoreFile.files?.[0];
      const cid = restoreCid.value.trim();
      if (!file && !cid) {
        restoreMsg.textContent = "Pick the backup file, or paste its IPFS CID.";
        return;
      }
      if (!restorePass.value) {
        restoreMsg.textContent = "The backup can't be opened without its passphrase.";
        return;
      }
      restoreBtn.disabled = true;
      restoreBtn.textContent = "Restoring…";
      try {
        const bytes = file
          ? new Uint8Array(await file.arrayBuffer())
          : await fetchFromIpfs(cid);
        const { docs } = await decryptCheckpoint(bytes, restorePass.value);
        await initSubduction();
        // Decode the backup, then pour it into a brand-new org. The restored
        // org is encrypted like any other, which a straight re-import could
        // never be: encryption is fixed when a document is created.
        const scratch = new Repo({ storage: new IndexedDBStorageAdapter("bam-restore-scratch") });
        const snapshot = readCheckpointDocs(scratch, docs);
        const restored = await openStore({
          storage: new IndexedDBStorageAdapter("bam-local-first"),
          endpoints: [],
          createOrg: snapshot.roster.org,
          deviceName: "restored device",
        });
        restoreInto(restored, snapshot);
        await restored.repo.flush();
        saveConfig({
          mode: "join",
          rosterUrl: restored.roster.url,
          endpoint: DEFAULT_SYNC_ENDPOINT,
        });
        location.reload();
      } catch (err) {
        restoreMsg.textContent = err instanceof Error ? err.message : String(err);
        restoreBtn.disabled = false;
        restoreBtn.textContent = "Restore this org";
      }
    };
    const restoreDetails = el("details", { class: "advanced" });
    restoreDetails.append(
      el("summary", {}, "Restore from a backup"),
      el(
        "p",
        { class: "muted", style: "margin:8px 0 0;font-size:13px" },
        "Made an encrypted checkpoint in Admin → Backups? Bring the whole org back with the file (or its IPFS CID) and the passphrase."
      ),
      field("Backup file", restoreFile),
      field("IPFS CID", restoreCid),
      field("Passphrase", restorePass),
      restoreBtn,
      restoreMsg
    );
    const restoreCard = el("div", { class: "card stack" });
    restoreCard.append(restoreDetails);

    wrap.append(hero, createCard, joinCard, restoreCard, keynote);
    root.append(wrap);
  });
}

// The operator console is copied verbatim from bam/web/ as classic IIFE
// scripts. We inline their SOURCE at build time (?raw) and run them as
// inline <script> elements after BAM.api is set — so the whole app is a
// single self-contained bundle (no runtime /console/*.js fetches), which
// is what lets StatiCrypt encrypt it as one file.
const CONSOLE_SCRIPTS: string[] = [
  consoleApp,
  viewHome,
  viewCheckin,
  viewAppointments,
  viewLookup,
  viewIntake,
  viewOutreach,
  viewFurniture,
  viewServices,
  viewDistros,
  viewShifts,
  viewData,
  viewDashboard,
];

function runInlineScript(code: string): void {
  const script = document.createElement("script");
  script.textContent = code;
  document.body.append(script);
}

/** QR onboarding: `#invite=…` in the URL → name + a few optional questions
 * that help the team match the volunteer to work (languages → interpreter
 * shifts, vehicle → driver slots, availability → scheduling). */
async function inviteScreen(
  root: HTMLElement,
  payload: InvitePayload,
  hadExistingOrg = false
): Promise<{
  config: AppConfig;
  deviceName: string;
  profile?: import("../src/schema.ts").VolunteerProfile;
}> {
  return new Promise((resolve) => {
    root.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card stack";
    card.style.cssText = "max-width:520px;margin:48px auto";
    const replaceNote = hadExistingOrg
      ? `<div class="note">This device already belongs to another org — joining this invite switches it to <b>${payload.org ?? "the invited org"}</b> as a volunteer.</div>`
      : "";
    const langShort = (label: string): string => {
      const parts = label.split("/").map((s) => s.trim()).filter(Boolean);
      return parts[1] ?? parts[0] ?? label;
    };
    const langChips = LANGUAGES.map(
      (label, i) =>
        `<button type="button" class="langchip" data-lang="${i}" aria-pressed="false">${langShort(label)}</button>`
    ).join("");
    const availability = ["Weekday mornings", "Weekday afternoons", "Weekday evenings", "Weekends"];
    const availChips = availability
      .map(
        (a, i) =>
          `<button type="button" class="langchip" data-avail="${i}" aria-pressed="false">${a}</button>`
      )
      .join("");
    card.innerHTML = `
      <h2 class="card__title">You're invited to ${payload.org ?? "a BAM org"} 🎉</h2>
      <p class="muted" style="margin:0">This enrolls your device as a <b>volunteer</b>.
      Just your name is required — the rest helps the team match you to shifts.</p>
      ${replaceNote}
      <div class="field">
        <label class="label" for="invite-device-name">Your name</label>
        <input class="input" id="invite-device-name" placeholder="e.g. Rosa" autocomplete="off">
      </div>
      <div class="field">
        <span class="label">Languages you can work in <span class="muted">(optional)</span></span>
        <div class="langpicker__grid">${langChips}</div>
      </div>
      <div class="field">
        <label class="label" for="invite-neighborhood">Where are you based? <span class="muted">(optional)</span></label>
        <input class="input" id="invite-neighborhood" placeholder="e.g. Bushwick" autocomplete="off">
      </div>
      <div class="field">
        <label class="label" for="invite-vehicle">Do you have a vehicle? <span class="muted">(optional)</span></label>
        <select class="input" id="invite-vehicle">
          <option value="">No vehicle</option>
          <option value="bike">Bike / cargo bike</option>
          <option value="car">Car</option>
          <option value="van">Van or truck</option>
        </select>
      </div>
      <div class="field">
        <span class="label">When can you usually help? <span class="muted">(optional)</span></span>
        <div class="langpicker__grid">${availChips}</div>
      </div>
      <div class="field">
        <label class="label" for="invite-skills">Anything else the team should know? <span class="muted">(optional)</span></label>
        <input class="input" id="invite-skills" placeholder="e.g. nurse, can lift heavy, speaks some ASL" autocomplete="off">
      </div>
      <button class="btn btn-primary btn-block" id="invite-join-btn">Join as a volunteer</button>`;
    root.append(card);
    const input = card.querySelector<HTMLInputElement>("#invite-device-name")!;
    const btn = card.querySelector<HTMLButtonElement>("#invite-join-btn")!;
    // Chip toggles (no framework on this screen — tiny inline handler).
    card.querySelectorAll<HTMLButtonElement>(".langchip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const on = chip.getAttribute("aria-pressed") === "true";
        chip.setAttribute("aria-pressed", String(!on));
        chip.classList.toggle("langchip--on", !on);
      });
    });
    input.focus();
    const go = (): void => {
      const deviceName = input.value.trim();
      if (!deviceName) {
        input.focus();
        return;
      }
      const selLangs = Array.from(
        card.querySelectorAll<HTMLButtonElement>('.langchip[data-lang][aria-pressed="true"]')
      ).map((c) => LANGUAGES[Number(c.dataset.lang)]!);
      const selAvail = Array.from(
        card.querySelectorAll<HTMLButtonElement>('.langchip[data-avail][aria-pressed="true"]')
      ).map((c) => availability[Number(c.dataset.avail)]!);
      const neighborhood = card.querySelector<HTMLInputElement>("#invite-neighborhood")!.value.trim();
      const vehicle = card.querySelector<HTMLSelectElement>("#invite-vehicle")!.value;
      const skills = card.querySelector<HTMLInputElement>("#invite-skills")!.value.trim();
      const profile: import("../src/schema.ts").VolunteerProfile = {};
      if (selLangs.length) profile.languages = selLangs;
      if (selAvail.length) profile.availability = selAvail;
      if (neighborhood) profile.neighborhood = neighborhood;
      if (vehicle) profile.vehicle = vehicle;
      if (skills) profile.skills = skills;
      resolve({
        config: {
          mode: "join",
          rosterUrl: payload.rosterUrl,
          endpoint: payload.endpoint,
          relayPeer: payload.relayPeer,
        },
        deviceName,
        profile: Object.keys(profile).length ? profile : undefined,
      });
    };
    btn.onclick = go;
    input.onkeydown = (e) => {
      if (e.key === "Enter") go();
    };
  });
}

async function boot(): Promise<void> {
  const root = document.getElementById("boot-root")!;
  const storage = new IndexedDBStorageAdapter("bam-local-first");

  // Read the hash BEFORE any stripping. An invite and a `#reset` can be
  // present together (e.g. a "run fresh" link) — parse both first, then
  // clean the URL once, so stripping never eats the invite.
  const invitePayload = parseInviteUrl(location.hash);
  const wantsReset = /[#&]reset\b/.test(location.hash);
  if (wantsReset) {
    localStorage.removeItem(CONFIG_KEY);
  }
  if (invitePayload || wantsReset) {
    // Drop the credential + flags from the address bar/history.
    history.replaceState(null, "", location.pathname + location.search);
  }

  let inviteRedemption: { inviteId: string; secret: string; deviceName: string } | undefined;

  let config = loadConfig();
  // An invite link takes PRECEDENCE over a previously-saved org — otherwise
  // a returning visitor who once created their own org would silently land
  // back in it (as its admin) and the invite would be ignored. Skip only if
  // this device is already configured for the *same* org the invite targets.
  if (invitePayload && (!config || config.rosterUrl !== invitePayload.rosterUrl)) {
    const joined = await inviteScreen(root, invitePayload, !!config);
    config = joined.config;
    inviteRedemption = {
      inviteId: invitePayload.inviteId,
      secret: invitePayload.secret,
      deviceName: joined.deviceName,
      ...(joined.profile ? { profile: joined.profile } : {}),
    };
  }
  if (!config) {
    // Only the first-run screen needs the device key up front, to show the
    // operator. It lives in the same storage as this device's encryption keys,
    // so ask the encryption layer for it rather than keeping a second copy —
    // and only here, so a returning device builds one keyhive instance, not two.
    const { peerId } = await openKeyhiveRepo({ storage, endpoints: [] });
    config = await firstRunScreen(root, peerId);
  }

  root.innerHTML = "<div class='loading'>Opening the local store…</div>";
  let store: BamStore;
  try {
    store = await openStore({
      storage,
      invite: inviteRedemption,
      endpoints: config.endpoint ? [config.endpoint] : [],
      alwaysAllow: config.relayPeer ? [config.relayPeer] : [],
      ...(config.mode === "join"
        ? { rosterUrl: config.rosterUrl }
        : {
            createOrg: config.orgName ?? "My Mutual Aid",
            deviceName: config.deviceName || "founding device",
            orgConfig: config.orgConfig,
          }),
    });
  } catch (err) {
    localStorage.removeItem(CONFIG_KEY);
    root.innerHTML = `<div class='card' style='max-width:560px;margin:40px auto'>
      <b>Could not open the org.</b>
      <div class='list-item__meta'>${err instanceof Error ? err.message : String(err)}</div>
      <div class='list-item__meta'>Config was reset — reload to try again.</div></div>`;
    return;
  }
  // Persist config only after a successful open, with the resolved roster URL
  // so subsequent loads work fully offline.
  saveConfig({ ...config, mode: "join", rosterUrl: store.roster.url });

  // Console bootstrap: adapter + languages first, then the classic scripts.
  const w = window as unknown as { BAM?: Record<string, unknown> };
  w.BAM = w.BAM || {};
  w.BAM.api = makeWebApi(store);
  w.BAM.LANGUAGES = [...LANGUAGES];
  // Roster-backed access control, exposed for the Admin/Roster views:
  // membership + revocation, per-domain sync grants (enforced by the policy
  // in roster.ts on every compliant peer), and app-level capability grants.
  w.BAM.access = {
    myPeerId: store.peerId,
    isAdmin: () => isAdmin(store.roster.doc(), store.peerId),
    members: () =>
      Object.values(store.roster.doc()?.members ?? {}).map((m) => ({
        peerId: m.peerId,
        name: m.name,
        role: m.role,
        revoked: !!m.revokedAt,
        lastSeenAt: m.lastSeenAt ?? null,
        profile: m.profile ?? null,
      })),
    /** This device's volunteer profile (languages, vehicle, availability). */
    myProfile: () => store.roster.doc()?.members[store.peerId]?.profile ?? null,
    revoke: (peerId: string) => revokeMember(store.roster, store.peerId, peerId),
    reinstate: (peerId: string) => reinstateMember(store.roster, store.peerId, peerId),
    // Data domains (Architecture A): grant/deny what each device may SYNC.
    domains: () =>
      Object.entries(store.roster.doc()?.dataDomains ?? {}).map(([key, d]) => ({
        key,
        label: d.name,
        hint: `Denied devices stop syncing the ${d.name} data entirely.`,
      })),
    grantsFor: (peerId: string) =>
      ({ ...(store.roster.doc()?.members[peerId]?.dataGrants ?? {}) }),
    setGrant: (peerId: string, domainKey: string, allowed: boolean) =>
      setDomainGrant(store.roster, store.peerId, peerId, domainKey, allowed),
    // App-level capabilities (accident guards, e.g. "contactFix").
    capsFor: (peerId: string) =>
      ({ ...(store.roster.doc()?.members[peerId]?.caps ?? {}) }),
    setCap: (peerId: string, cap: string, on: boolean) =>
      setCap(store.roster, store.peerId, peerId, cap, on),
    hasCap: (cap: string) => hasCap(store.roster.doc(), store.peerId, cap),
    // Per-device view grants: which optional screens/tables a device's app
    // shows and serves (app-level tier; dataGrants is the sync-level tier).
    deviceViews: DEVICE_VIEWS.map((v) => ({ ...v })),
    viewGrantsFor: (peerId: string) =>
      ({ ...(store.roster.doc()?.members[peerId]?.viewGrants ?? {}) }),
    setViewGrant: (peerId: string, view: string, allowed: boolean) =>
      setViewGrant(store.roster, store.peerId, peerId, view, allowed),
    onChange: (cb: () => void) => store.roster.on("change", cb),
  };

  // Keep decryption keys in step with the roster. Membership edits are plain
  // document writes — they can't grant keys themselves, because the admin
  // making them may be offline and granting is asynchronous. So watch the
  // roster instead: every change (ours or a peer's) reconciles, which also
  // catches a volunteer publishing their contact card minutes after being
  // added. Debounced because a single UI action can touch the doc repeatedly,
  // and serialised because keyhive's WASM is not reentrant.
  {
    let pending: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const reconcile = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const changed = await syncAccess(store);
        if (changed.granted.length || changed.revoked.length) {
          console.info("[keyhive] access updated", changed);
        }
      } catch (err) {
        console.warn("[keyhive] could not update access", err);
      } finally {
        running = false;
      }
    };
    store.roster.on("change", () => {
      clearTimeout(pending);
      pending = setTimeout(() => void reconcile(), 1500);
    });
    // Also on a timer: a volunteer's card arrives by sync, and if it lands
    // while this admin is mid-reconcile the change event above is already
    // spent. Cheap when there is nothing to do (a list comparison).
    setInterval(() => void reconcile(), 30000);
  }
  // The router consults this per-device map on top of the org's feature
  // toggles — a denied view disappears from the nav and won't render.
  const myViewDenials = (): Record<string, boolean> => {
    const denials: Record<string, boolean> = {};
    for (const { view } of DEVICE_VIEWS) {
      if (!viewAllowed(store.roster.doc(), store.peerId, view)) denials[view] = false;
    }
    return denials;
  };
  w.BAM.deviceViewGrants = myViewDenials();
  // Presence: stamp this device's lastSeenAt (throttled inside touchLastSeen)
  // so admins can run access-recert sweeps against real activity.
  try {
    touchLastSeen(store.roster, store.peerId);
  } catch {
    /* non-members (mid-join races) simply don't stamp */
  }

  for (const code of CONSOLE_SCRIPTS) runInlineScript(code);
  // The Admin view (expire / publish website data / scrub PII) is only
  // registered for roster admins. This is a guard against accidents, not a
  // security boundary — in a local-first app every enrolled device holds the
  // whole doc; real enforcement is the sync policy + eventual Keyhive
  // per-doc capabilities.
  const adminAtBoot = isAdmin(store.roster.doc(), store.peerId);
  if (adminAtBoot) runInlineScript(viewAdmin);
  registerRosterView(store);
  registerSettingsView(store);

  // If THIS device's role changes (promoted/demoted by an admin elsewhere),
  // reload so the nav matches the new role. Roster changes are frequent
  // (every join touches the doc) — only react when our own role flips, or
  // when our own view grants change (admin granted/denied a screen live).
  let viewGrantsAtBoot = JSON.stringify(w.BAM.deviceViewGrants);
  store.roster.on("change", () => {
    if (isAdmin(store.roster.doc(), store.peerId) !== adminAtBoot) {
      location.reload();
      return;
    }
    const next = myViewDenials();
    const serialized = JSON.stringify(next);
    if (serialized !== viewGrantsAtBoot) {
      viewGrantsAtBoot = serialized;
      w.BAM.deviceViewGrants = next;
      void (w.BAM as { refreshChrome?: () => Promise<void> }).refreshChrome?.();
    }
  });

  root.remove();
  (w.BAM as { start: () => void }).start();
}

void boot();
