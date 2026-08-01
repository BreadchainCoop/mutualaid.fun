/**
 * "Roster" console view — the access-control panel this branch exists for.
 *
 * Shows this device's identity and sync status, and (for admins) manages
 * the roster: add a device by its peer id, revoke one. Registered into the
 * console's view registry after app.js loads, so it uses the same BAM.h /
 * component classes as every other view.
 */

import QRCode from "qrcode";

import type { BamStore } from "./store.ts";
import {
  addMember,
  buildInviteUrl,
  createInvite,
  isAdmin,
  reinstateMember,
  revokeInvite,
  revokeMember,
  setCap,
  setRole,
  setViewGrant,
  updateOwnProfile,
  type InvitePayload,
} from "./roster.ts";
import { LANGUAGES } from "./domain/catalog.ts";
import { DEVICE_VIEWS } from "./schema.ts";
import type { Role, RosterMember, VolunteerProfile } from "./schema.ts";

const AVAILABILITY = ["Weekday mornings", "Weekday afternoons", "Weekday evenings", "Weekends"];
const VEHICLES: Array<[string, string]> = [
  ["", "No vehicle"],
  ["bike", "Bike / cargo bike"],
  ["car", "Car"],
  ["van", "Van or truck"],
];

function langShortLabel(label: string): string {
  const parts = label.split("/").map((s) => s.trim()).filter(Boolean);
  return parts[1] ?? parts[0] ?? label;
}

/** One-line human summary of a volunteer profile for the members list. */
function profileSummary(p: VolunteerProfile | undefined): string {
  if (!p) return "";
  const bits: string[] = [];
  if (p.languages?.length) bits.push(`🗣 ${p.languages.map(langShortLabel).join(", ")}`);
  if (p.neighborhood) bits.push(`📍 ${p.neighborhood}`);
  if (p.vehicle) bits.push(`🚗 ${p.vehicle}`);
  if (p.availability?.length) bits.push(`🕐 ${p.availability.join(", ")}`);
  if (p.skills) bits.push(`💪 ${p.skills}`);
  return bits.join(" · ");
}

interface BamNamespace {
  h: (tag: string, attrs?: unknown, ...children: unknown[]) => HTMLElement;
  clear: (el: HTMLElement) => void;
  toast: (msg: string, kind?: string) => void;
  fmtDateTime: (iso: string) => string;
  registerView: (name: string, def: { title: string; icon?: string; render: (c: HTMLElement) => void }) => void;
}

export function registerRosterView(store: BamStore): void {
  const BAM = (window as unknown as { BAM: BamNamespace }).BAM;
  const { h, clear, toast } = BAM;

  // Destructive / high-impact actions confirm inline before firing. Keyed by
  // `${verb}:${id}`; persists across the view's re-renders.
  const confirming = new Set<string>();

  function render(container: HTMLElement): void {
    const roster = store.roster.doc()!;
    const admin = isAdmin(roster, store.peerId);
    const netEndpoint = (() => {
      try {
        return (JSON.parse(localStorage.getItem("bam-local-first-config") ?? "{}") as { endpoint?: string })
          .endpoint;
      } catch {
        return undefined;
      }
    })();

    clear(container);

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Volunteers"),
      h(
        "p",
        { class: "muted" },
        "Who's here, and what they can do. Only people you add can see or change your community's data — everyone else is turned away."
      )
    );

    // This device.
    const me = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, `${roster.org} — this device`),
      h("div", { class: "list-item__meta" }, "Peer id (share with an admin to be enrolled):"),
      h("div", { class: "mono", style: { wordBreak: "break-all", fontSize: "13px" } }, store.peerId),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn",
            onclick: () => {
              void navigator.clipboard.writeText(store.peerId).then(() => toast("Peer id copied.", "success"));
            },
          },
          "Copy peer id"
        ),
        h(
          "span",
          { class: "pill" },
          store.repo.isSubductionConnected() ? "sync: connected" : "sync: offline"
        ),
        h("span", { class: "pill" }, admin ? "admin" : "volunteer")
      ),
      h("div", { class: "list-item__meta" }, "Roster link (new devices join with this):"),
      h(
        "div",
        { class: "row" },
        h(
          "div",
          { class: "mono grow", style: { wordBreak: "break-all", fontSize: "13px" } },
          store.roster.url
        ),
        h(
          "button",
          {
            class: "btn",
            onclick: () => {
              void navigator.clipboard
                .writeText(store.roster.url)
                .then(() => toast("Roster link copied.", "success"));
            },
          },
          "Copy"
        )
      ),
      h(
        "div",
        { class: "list-item__meta" },
        netEndpoint
          ? `Sync relay: ${netEndpoint}`
          : "Sync relay: none — this device is offline-only. Add one when you invite another device (below)."
      ),
      // Log out: forget this device's saved connection and return to the
      // start screen (create or join another org). Honest edges: enrollment
      // stays on the roster until an admin revokes it, and the org's local
      // copy stays in this browser until you rejoin or clear site data.
      h(
        "div",
        { class: "row", style: { marginTop: "var(--s2)" } },
        confirmBtn("logout:me", "Log out of this org", "Confirm — log out", "btn-danger", () => {
          localStorage.removeItem("bam-local-first-config");
          location.hash = "";
          location.reload();
        })
      ),
      h(
        "div",
        { class: "list-item__meta" },
        "Logging out returns this device to the start screen so you can create or join another org. You stay on this team's roster until an admin revokes you, and the data already synced here stays in this browser until you rejoin or clear site data."
      )
    );

    // Admin action buttons per member (promote/demote/revoke/reinstate).
    function actionBtn(label: string, cls: string, fn: () => void): HTMLElement {
      return h(
        "button",
        {
          class: `btn ${cls}`,
          onclick: () => {
            try {
              fn();
              render(container);
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err), "error");
            }
          },
        },
        label
      );
    }

    // A two-step button for destructive/high-impact actions: first tap arms it
    // (shows Confirm + Cancel), second confirms. Prevents accidental one-taps.
    function confirmBtn(
      key: string,
      label: string,
      confirmLabel: string,
      cls: string,
      fn: () => void
    ): HTMLElement {
      if (confirming.has(key)) {
        return h(
          "span",
          { class: "row", style: { gap: "6px" } },
          h(
            "button",
            {
              class: `btn ${cls}`,
              onclick: () => {
                confirming.delete(key);
                try {
                  fn();
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), "error");
                }
                render(container);
              },
            },
            confirmLabel
          ),
          h(
            "button",
            {
              class: "btn btn-ghost",
              onclick: () => {
                confirming.delete(key);
                render(container);
              },
            },
            "Cancel"
          )
        );
      }
      return h(
        "button",
        {
          class: `btn ${cls}`,
          onclick: () => {
            confirming.add(key);
            render(container);
          },
        },
        label
      );
    }
    function memberActions(m: { peerId: string; name: string; role: string; revokedAt?: string }) {
      if (m.peerId === store.peerId) return []; // no actions on yourself (lockout-safe)
      if (m.revokedAt) {
        return [
          actionBtn("Reinstate", "btn-ghost", () => {
            reinstateMember(store.roster, store.peerId, m.peerId);
            toast(`Reinstated ${m.name}.`, "success");
          }),
        ];
      }
      const actions: HTMLElement[] = [];
      if (m.role === "volunteer") {
        // Granting admin is a privilege escalation → confirm.
        actions.push(
          confirmBtn(`admin:${m.peerId}`, "Make admin", "Confirm — make admin", "btn-ghost", () => {
            setRole(store.roster, store.peerId, m.peerId, "admin");
            toast(`${m.name} is now an admin.`, "success");
          })
        );
      } else {
        actions.push(
          actionBtn("Make volunteer", "btn-ghost", () => {
            setRole(store.roster, store.peerId, m.peerId, "volunteer");
            toast(`${m.name} is now a volunteer.`, "success");
          })
        );
      }
      // Revoking cuts off a teammate's access → confirm.
      actions.push(
        confirmBtn(`revoke:${m.peerId}`, "Revoke", "Confirm revoke", "btn-danger", () => {
          revokeMember(store.roster, store.peerId, m.peerId);
          toast(`Revoked ${m.name} — they'll stop getting updates.`, "success");
        })
      );
      return actions;
    }

    // App-level capability chips (admin, on active volunteers): accident-guard
    // grants like "can fix contacts" — enforced in the adapter, not the sync
    // layer, and always implied for admins.
    const CAPS: Array<{ key: string; label: string; hint: string }> = [
      {
        key: "contactFix",
        label: "🛠 can fix contacts",
        hint: "Lets this device correct household phone/email (audited, masked).",
      },
      {
        key: "partnerSync",
        label: "🔄 can run partner sync",
        hint: "Lets this device apply partner fulfillment phone-lists.",
      },
    ];
    // Per-device VIEW grants — total granularity over which screens/tables a
    // volunteer's device shows and serves. Green chip = can open; tap to
    // toggle. (App-level tier: the device's app hides AND refuses the table;
    // the sync-level tier is the Data access card in Admin.)
    function viewChips(m: RosterMember): HTMLElement | null {
      if (!admin || m.revokedAt || m.role !== "volunteer") return null;
      return h(
        "div",
        { class: "stack", style: { gap: "4px", marginTop: "var(--s1)" } },
        h("div", { class: "list-item__meta" }, "Can open:"),
        h(
          "div",
          { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          ...DEVICE_VIEWS.map(({ view, label }) => {
            const on = m.viewGrants?.[view] !== false;
            return h(
              "button",
              {
                type: "button",
                class: on ? "langchip langchip--on" : "langchip",
                title: on
                  ? `${label}: this device can open it — tap to take it away`
                  : `${label}: hidden and refused on this device — tap to allow`,
                "aria-pressed": String(on),
                onclick: () => {
                  try {
                    setViewGrant(store.roster, store.peerId, m.peerId, view, !on);
                    toast(
                      !on
                        ? `${m.name} can open ${label} again.`
                        : `${label} is now hidden on ${m.name}'s device.`,
                      "success"
                    );
                    render(container);
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), "error");
                  }
                },
              },
              (on ? "✓ " : "✕ ") + label
            );
          })
        )
      );
    }

    function capChips(m: RosterMember): HTMLElement | null {
      if (!admin || m.revokedAt || m.role !== "volunteer") return null;
      return h(
        "div",
        { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        ...CAPS.map((cap) => {
          const on = m.caps?.[cap.key] === true;
          return h(
            "button",
            {
              type: "button",
              class: on ? "pill pill--on" : "pill",
              title: cap.hint,
              "aria-pressed": String(on),
              onclick: () => {
                try {
                  setCap(store.roster, store.peerId, m.peerId, cap.key, !on);
                  toast(
                    !on
                      ? `${m.name}: ${cap.label.replace(/^\S+\s/, "")} granted.`
                      : `${m.name}: grant removed.`,
                    "success"
                  );
                  render(container);
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), "error");
                }
              },
            },
            (on ? "✓ " : "") + cap.label
          );
        })
      );
    }

    // Members list.
    const members = Object.values(roster.members).sort((a, b) =>
      a.addedAt < b.addedAt ? -1 : 1
    );
    const memberRows = members.map((m) =>
      h(
        "li",
        { class: "list-item", style: { flexWrap: "wrap" } },
        h(
          "div",
          { class: "list-item__body" },
          h("div", { class: "list-item__label" }, m.name),
          h(
            "div",
            { class: "list-item__meta mono", style: { wordBreak: "break-all" } },
            m.peerId
          ),
          h(
            "div",
            { class: "list-item__meta" },
            m.lastSeenAt ? `Last seen ${BAM.fmtDateTime(m.lastSeenAt)}` : "Last seen: —"
          ),
          m.profile && profileSummary(m.profile)
            ? h("div", { class: "list-item__meta" }, profileSummary(m.profile))
            : null,
          viewChips(m),
          capChips(m)
        ),
        h(
          "span",
          { class: `badge ${m.revokedAt ? "badge-timeout" : "badge-open"}` },
          m.revokedAt ? "revoked" : m.role
        ),
        m.peerId === store.peerId ? h("span", { class: "pill" }, "you") : null,
        admin ? h("div", { class: "row" }, memberActions(m)) : null
      )
    );
    const membersCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, `Members (${members.length})`),
      h("ul", { class: "list" }, memberRows)
    );

    // Admin: add a device.
    const peerInput = h("input", {
      class: "input",
      id: "roster-peer",
      placeholder: "peer id (64 hex chars)",
    }) as HTMLInputElement;
    const nameInput = h("input", {
      class: "input",
      id: "roster-name",
      placeholder: "device / volunteer name",
    }) as HTMLInputElement;
    const roleSelect = h("select", { class: "input", id: "roster-role" }) as HTMLSelectElement;
    for (const role of ["volunteer", "admin"]) {
      const opt = document.createElement("option");
      opt.value = role;
      opt.textContent = role;
      roleSelect.append(opt);
    }
    const addCard = admin
      ? h(
          "div",
          { class: "card stack" },
          h("h2", { class: "card__title" }, "Enroll a device"),
          h("div", { class: "field" }, h("label", { class: "label", for: "roster-peer" }, "Peer id"), peerInput),
          h("div", { class: "field" }, h("label", { class: "label", for: "roster-name" }, "Name"), nameInput),
          h("div", { class: "field" }, h("label", { class: "label", for: "roster-role" }, "Role"), roleSelect),
          h(
            "button",
            {
              class: "btn btn-primary btn-block",
              onclick: () => {
                const peerId = peerInput.value.trim().toLowerCase();
                const name = nameInput.value.trim();
                if (!/^[0-9a-f]{64}$/.test(peerId)) {
                  toast("Peer id must be 64 hex characters.", "error");
                  return;
                }
                if (!name) {
                  toast("Give the device a name.", "error");
                  return;
                }
                try {
                  addMember(store.roster, store.peerId, {
                    peerId,
                    name,
                    role: roleSelect.value as Role,
                  });
                  toast(`Enrolled ${name}.`, "success");
                  render(container);
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), "error");
                }
              },
            },
            "Enroll device"
          )
        )
      : h(
          "div",
          { class: "card" },
          h("div", { class: "empty-state" }, h("div", {}, "Only admins can enroll or revoke devices."))
        );

    // ---- QR invites (admin): scan-to-onboard volunteers -------------------
    const inviteNameInput = h("input", {
      class: "input",
      id: "invite-name",
      placeholder: 'e.g. "July distro volunteers"',
    }) as HTMLInputElement;
    const inviteDaysInput = h("input", {
      class: "input",
      id: "invite-days",
      type: "number",
      value: "7",
    }) as HTMLInputElement;
    const inviteUsesInput = h("input", {
      class: "input",
      id: "invite-uses",
      type: "number",
      value: "20",
    }) as HTMLInputElement;
    // Permission presets baked into the invite: whoever scans it arrives with
    // exactly these — no follow-up grants for the admin to remember.
    const permDistros = h("input", { type: "checkbox", id: "invite-perm-distros", checked: true }) as HTMLInputElement;
    const permContactFix = h("input", { type: "checkbox", id: "invite-perm-contactfix" }) as HTMLInputElement;
    const permPartnerSync = h("input", { type: "checkbox", id: "invite-perm-partnersync" }) as HTMLInputElement;
    const permRow = (box: HTMLInputElement, label: string, hint: string): HTMLElement =>
      h(
        "label",
        { class: "list-item list-item--selectable", for: box.id, style: { cursor: "pointer" } },
        box,
        h(
          "div",
          { class: "list-item__body" },
          h("div", { class: "list-item__label" }, label),
          h("div", { class: "list-item__meta" }, hint)
        )
      );
    // Per-view invite presets: whoever scans arrives able to open exactly
    // these screens/tables — total granularity, zero follow-up grants.
    const inviteViewBoxes = new Map<string, HTMLInputElement>();
    const inviteViewGrid = h(
      "div",
      { class: "row", style: { gap: "var(--s2)", flexWrap: "wrap" } },
      DEVICE_VIEWS.map(({ view, label }) => {
        const box = h("input", { type: "checkbox", id: `invite-view-${view}`, checked: true }) as HTMLInputElement;
        inviteViewBoxes.set(view, box);
        return h(
          "label",
          {
            class: "row",
            for: `invite-view-${view}`,
            style: { gap: "4px", cursor: "pointer", border: "1px solid var(--border)", borderRadius: "8px", padding: "4px 8px" },
          },
          box,
          h("span", { style: { fontSize: "13.5px" } }, label)
        );
      })
    );
    const invitePerms = h(
      "div",
      { class: "field" },
      h("span", { class: "label" }, "People who join with this QR can open…"),
      h(
        "div",
        { class: "list-item__meta" },
        "Untick anything they shouldn't see. Check-in, Intake and Look up are always on; you can change any of this later per device."
      ),
      inviteViewGrid,
      h("span", { class: "label", style: { marginTop: "var(--s2)" } }, "…and additionally may:"),
      permRow(permDistros, "Sync the distros & shifts data at all", "The hard boundary: unchecked, that data never reaches their device."),
      permRow(permContactFix, "Fix phone numbers & emails", "For trusted data-cleanup volunteers. Every fix is logged."),
      permRow(permPartnerSync, "Run partner syncs", "Apply a partner org's fulfillment lists.")
    );
    const inviteResult = h("div", { class: "stack" });

    const invitesList = () => {
      const invites = Object.values(store.roster.doc()?.invites ?? {});
      if (!invites.length) return null;
      return h(
        "ul",
        { class: "list" },
        invites.map((inv) =>
          h(
            "li",
            { class: "list-item" },
            h(
              "div",
              { class: "list-item__body" },
              h("div", { class: "list-item__label" }, inv.name),
              h(
                "div",
                { class: "list-item__meta" },
                `expires ${BAM.fmtDateTime(inv.expiresAt)} · max ${inv.maxUses} uses · ` +
                  `${Object.values(store.roster.doc()?.members ?? {}).filter((m) => m.inviteId === inv.id).length} joined` +
                  (inv.revokedAt ? " · REVOKED" : "")
              )
            ),
            !inv.revokedAt && admin
              ? confirmBtn(`revoke-invite:${inv.id}`, "Revoke", "Confirm revoke", "btn-danger", () => {
                  revokeInvite(store.roster, store.peerId, inv.id);
                  toast("Invite revoked — no new devices can use it.", "success");
                })
              : null
          )
        )
      );
    };

    const makeInvite = async (): Promise<void> => {
      const name = inviteNameInput.value.trim();
      if (!name) {
        toast("Give the invite a name.", "error");
        return;
      }
      try {
        const caps: { [cap: string]: boolean } = {};
        if (permContactFix.checked) caps.contactFix = true;
        if (permPartnerSync.checked) caps.partnerSync = true;
        const dataGrants: { [key: string]: boolean } = {};
        if (!permDistros.checked) dataGrants.distros = false;
        const viewGrants: { [view: string]: boolean } = {};
        for (const [view, box] of inviteViewBoxes) {
          if (!box.checked) viewGrants[view] = false;
        }
        const { invite, secret } = createInvite(store.roster, store.peerId, {
          name,
          expiresInDays: Number(inviteDaysInput.value) || 7,
          maxUses: Number(inviteUsesInput.value) || 20,
          ...(Object.keys(caps).length ? { caps } : {}),
          ...(Object.keys(dataGrants).length ? { dataGrants } : {}),
          ...(Object.keys(viewGrants).length ? { viewGrants } : {}),
        });
        const config = JSON.parse(localStorage.getItem("bam-local-first-config") ?? "{}") as {
          endpoint?: string;
          relayPeer?: string;
        };
        const payload: InvitePayload = {
          v: 1,
          org: store.roster.doc()?.org,
          rosterUrl: store.roster.url,
          endpoint: config.endpoint,
          relayPeer: config.relayPeer,
          inviteId: invite.id,
          secret,
        };
        const url = buildInviteUrl(location.origin + location.pathname, payload);
        const canvas = document.createElement("canvas");
        await QRCode.toCanvas(canvas, url, { width: 280, margin: 1 });
        clear(inviteResult);
        inviteResult.append(
          h("div", { class: "list-item__meta" }, `Scan to join "${roster.org}" as a volunteer:`),
          canvas,
          h(
            "button",
            {
              class: "btn",
              onclick: () => {
                void navigator.clipboard.writeText(url).then(() => toast("Invite link copied.", "success"));
              },
            },
            "Copy invite link"
          ),
          h(
            "div",
            { class: "note" },
            "This QR/link is a bearer credential: anyone who scans it joins as a volunteer until it expires or you revoke it. Share it like a key."
          )
        );
        toast("Invite created.", "success");
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
      }
    };

    const inviteCard = admin
      ? h(
          "div",
          { class: "card stack" },
          h("h2", { class: "card__title" }, "QR invite — scan to onboard"),
          h(
            "p",
            { class: "muted", style: { margin: "0" } },
            "Mint a QR code that pre-authorizes new volunteer devices: scan → name yourself → enrolled."
          ),
          h("div", { class: "field" }, h("label", { class: "label", for: "invite-name" }, "Invite name"), inviteNameInput),
          invitePerms,
          h(
            "div",
            { class: "row" },
            h("div", { class: "field grow" }, h("label", { class: "label", for: "invite-days" }, "Expires (days)"), inviteDaysInput),
            h("div", { class: "field grow" }, h("label", { class: "label", for: "invite-uses" }, "Max uses"), inviteUsesInput)
          ),
          h("button", { class: "btn btn-primary btn-block", onclick: () => void makeInvite() }, "Create QR invite"),
          inviteResult,
          invitesList()
        )
      : null;

    // ---- My profile: self-service volunteer details ------------------------
    const myMember = roster.members[store.peerId];
    let myProfileCard: HTMLElement | null = null;
    if (myMember && !myMember.revokedAt) {
      const p = myMember.profile ?? {};
      const selLangs = new Set(p.languages ?? []);
      const selAvail = new Set(p.availability ?? []);
      const chip = (label: string, display: string, set: Set<string>): HTMLElement => {
        const on = set.has(label);
        const el = h(
          "button",
          {
            type: "button",
            class: "langchip" + (on ? " langchip--on" : ""),
            "aria-pressed": String(on),
            onclick: () => {
              if (set.has(label)) set.delete(label);
              else set.add(label);
              el.classList.toggle("langchip--on", set.has(label));
              el.setAttribute("aria-pressed", String(set.has(label)));
            },
          },
          display
        );
        return el;
      };
      const neighborhoodInput = h("input", {
        class: "input",
        value: p.neighborhood ?? "",
        placeholder: "e.g. Bushwick",
        "aria-label": "Neighborhood",
      }) as HTMLInputElement;
      const vehicleSelect = h("select", { class: "input", "aria-label": "Vehicle" }) as HTMLSelectElement;
      for (const [value, label] of VEHICLES) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        if ((p.vehicle ?? "") === value) opt.selected = true;
        vehicleSelect.append(opt);
      }
      const skillsInput = h("input", {
        class: "input",
        value: p.skills ?? "",
        placeholder: "e.g. nurse, can lift heavy, speaks some ASL",
        "aria-label": "Skills",
      }) as HTMLInputElement;
      const saveProfile = h(
        "button",
        {
          class: "btn btn-primary",
          onclick: () => {
            try {
              updateOwnProfile(store.roster, store.peerId, {
                languages: [...selLangs],
                availability: [...selAvail],
                neighborhood: neighborhoodInput.value,
                vehicle: vehicleSelect.value,
                skills: skillsInput.value,
              });
              toast("Profile saved — the team can now match you to shifts.", "success");
              render(container);
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err), "error");
            }
          },
        },
        "Save my profile"
      );
      myProfileCard = h(
        "details",
        { class: "card stack advanced" },
        h("summary", {}, "🙋 My profile — help the team match you to shifts"),
        h(
          "div",
          { class: "stack", style: { marginTop: "var(--s3)" } },
          h(
            "div",
            { class: "field" },
            h("span", { class: "label" }, "Languages I can work in"),
            h("div", { class: "langpicker__grid" }, LANGUAGES.map((l) => chip(l, langShortLabel(l), selLangs)))
          ),
          h("div", { class: "field" }, h("span", { class: "label" }, "Where I'm based"), neighborhoodInput),
          h("div", { class: "field" }, h("span", { class: "label" }, "Vehicle"), vehicleSelect),
          h(
            "div",
            { class: "field" },
            h("span", { class: "label" }, "When I can usually help"),
            h("div", { class: "langpicker__grid" }, AVAILABILITY.map((a) => chip(a, a, selAvail)))
          ),
          h("div", { class: "field" }, h("span", { class: "label" }, "Anything else"), skillsInput),
          saveProfile
        )
      );
    }

    container.append(heading, me);
    if (myProfileCard) container.append(myProfileCard);
    container.append(membersCard, addCard);
    if (inviteCard) container.append(inviteCard);
  }

  BAM.registerView("roster", { title: "Volunteers", icon: "🤝", render });
}
