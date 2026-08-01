# Security & trust

Mutual aid work involves real people's names, phone numbers and addresses. This
page is an honest account of what the toolkit protects, and what it doesn't yet
— so you can decide how to run it.

## What you get

- **Your data lives on your devices.** There's no company server holding your
  community's information. Each device on your team keeps its own full copy;
  they reconcile changes when they can reach each other.
- **Your data is encrypted for your team only.** New orgs encrypt household
  data end-to-end, so a relay passing your updates along stores ciphertext it
  cannot read. See [End-to-end encryption](#end-to-end-encryption) below.
- **Device identity.** Every device has its own cryptographic key
  (Ed25519), kept in the browser's storage or, on the command line, a `0600`
  file. You are your device's key. (In an encrypted org that key must be
  usable by the encryption layer, so it is stored in a form a script running
  on the page could read — one more reason to keep the app on a device you
  trust and not paste unknown code into the browser console.)
- **A roster gates access.** Only devices an admin has put on the roster can
  sync your org's data. Everyone else is turned away automatically, on every
  device — this is deny-by-default, not a setting you have to switch on. Beyond
  the roster, an admin can also control *which data* each device sees, per
  domain — see [Control who sees which data](data-access.md).
- **Invites are revocable keys.** A QR/link invite lets a device self-enroll as
  a *volunteer* until it expires or you revoke it. It never grants admin.
- **Works offline.** No network is required to use the app; sync catches up
  later. Less data in flight is less data to intercept.

## What it does *not* do yet

Be clear-eyed about these, especially for sensitive data:

- **Orgs created before encryption shipped are still unencrypted.** They keep
  working exactly as before, but their data is readable by anyone who learns a
  document's address — we tested this, and an unenrolled device read household
  names and phone numbers off the shared relay in about four seconds. That is
  what "no encryption" means: a relay decides who may read a document from the
  access rules attached to it, and those documents carry none, so **any** relay
  will hand them over. The roster protects data your devices serve each other;
  it cannot protect data sitting on a relay.

  These orgs cannot be encrypted in place — encrypted documents get new
  addresses. Moving one across means creating a new org and re-entering or
  importing its data. If you hold real household PII in an org from before this
  change, that is worth doing.
- **In a local-first app, every enrolled device holds the whole dataset.** The
  admin/volunteer split hides destructive actions from volunteers, but it's a
  guard against accidents, not a hard security boundary between people already
  on your team. Only enroll devices you trust.
- **Revoking a device stops future sync**, but a device that already synced has
  a copy of what it saw. Treat revocation as "no more updates," not "unsee."

## End-to-end encryption

**New orgs are end-to-end encrypted.** Using
[Keyhive](https://github.com/inkandswitch/keyhive), your data is encrypted for
the specific devices you've added, and nobody else — including whoever runs the
relay — can read it.

- A relay stores **ciphertext it cannot read**. It shuttles your updates without
  being able to see a single name or phone number, so it no longer matters much
  whose relay you use.
- **Adding someone to your team gives them the keys; revoking takes them back.**
  This is arithmetic, not a rule other devices agree to follow. A revoked device
  cannot decrypt anything written after you removed it, even if it ignores every
  rule in this app.
- **Denying a data domain really denies it.** A volunteer you've denied
  distros can't decrypt distros — the data never becomes readable to them,
  rather than other devices politely declining to send it.

What this still doesn't hide, deliberately:

- **The roster itself is not encrypted.** It holds device names, roles and
  public keys, and a joining device has to read it to introduce itself before
  anyone can give it keys. The household data is what's encrypted.
- **A relay can see the shape of your activity** — which devices are online,
  when membership changes, how much traffic there is — just not its contents.
- **Revocation is still "no more updates," not "unsee."** A device keeps
  whatever it already synced. Only what comes after is out of reach.
- **Every device on your team can read everything** it's been granted. That's
  what local-first means; only add devices you'd trust with the whole list.

## Practical guidance

- **Run your own relay for real PII.** See [Run your own
  relay](self-host-relay.md). Keep the shared relay for trying things out.
- **Keep invites short-lived** and revoke ones you're done with.
- **Only add devices and admins you'd trust with the whole list**, because in a
  local-first tool, that's what they get.
- **Collect the minimum.** The less you record about people, the less there is
  to protect.

This is deliberately not a "military-grade encryption" pitch. It's a tool that
keeps your community's data on your community's devices, with honest edges. If
your threat model needs more, self-host the relay and keep your team small and
trusted.

---

Back to the [README](../README.md) · [Run your own relay](self-host-relay.md)
