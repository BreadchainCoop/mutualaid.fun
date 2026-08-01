# Run your own relay

A **relay** is a small connector that passes updates between your team's
devices. It's how a phone and a laptop — or two volunteers across town — see the
same org. Everything is still local-first: the relay just shuttles messages;
each device holds the whole dataset.

## The default: the community relay

Out of the box, orgs use `wss://keyhive.sync.automerge.org`, a community sync
server run by the [Automerge](https://automerge.org/) project. That's why you
can create an org and invite people immediately with nothing to configure.

**What the relay can and can't do.** Your data is end-to-end encrypted, so the
relay stores ciphertext it cannot read — it shuttles updates without ever seeing
a name or a phone number. It can still see the shape of things (which devices
are online, roughly how much is changing), just not the contents. That's the
trade: you get sync you don't have to run, and it learns your traffic pattern
but none of your data.

A relay has to run in **keyhive mode** to carry encrypted traffic. A server in
`--auth open` mode — including the older `wss://subduction.sync.inkandswitch.com`
— silently ignores it, so an org pointed at one appears to work locally and
never syncs.

> Running your own is still worth it if you'd rather not depend on someone
> else's uptime, or you want your community's traffic to stay on your own
> infrastructure. It is no longer required to keep your data private.

## Point your org at your own relay

You don't need to change any code. Wherever a relay is set, use your own
`wss://…` address instead of the default:

- **Creating an org:** open **Advanced: sync relay** on the create screen and
  put in your relay address (or clear it to keep the org on one device).
- **Joining an org:** open **Advanced: sync relay** on the join screen and use
  the same relay the org's admin uses.
- **Command line:** pass `--endpoint wss://your-relay` to `org join` and `sync`
  (see [`src/cli.ts`](../src/cli.ts)). A newly created org is offline-only until
  you first attach a relay this way.

Everyone on a team must point at the **same** relay to sync with each other.

## Trusting the relay

Each device trusts a relay by its key, and the default relay's key ships with
the app — there is nothing to configure or verify by hand. Point a device at a
relay of your own and you supply its key alongside the address (the server
prints it at startup as its **Peer ID**).

## Running the relay itself

The relay is a [Subduction](https://github.com/inkandswitch/subduction) sync
server, an Ink & Switch project rather than part of this toolkit. Prebuilt
binaries are published on its releases page for macOS and Linux; download the
one for your machine and run:

```
subduction server --socket 0.0.0.0:8944 --data-dir /var/lib/subduction
```

It prints a **Peer ID** at startup — that's the relay key you can pin (see
above). Put it behind TLS (a reverse proxy is fine) so devices can reach it at a
`wss://…` address, then point your org at it as above.

**Leave the default `--auth keyhive` mode on.** It is what carries encrypted
traffic and enforces access. The alternative, `--auth open`, disables access
control entirely *and* ignores encrypted sync — it exists for testing, and an
encrypted org pointed at it will never sync.

Your relay only ever holds ciphertext, so a compromise of the machine does not
expose household data. Keep it patched anyway: it can still see who is online
and when, and it is the thing your team depends on to sync at all.

If you'd rather not run any relay, an org works fully **offline on a single
device** — just leave the relay blank. You can add sync later without losing
anything.

---

Back to the [README](../README.md) · [Configure your org](configure-your-org.md)
· [Security & trust](security-and-trust.md)
