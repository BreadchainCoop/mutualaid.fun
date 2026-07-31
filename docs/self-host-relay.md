# Run your own relay

A **relay** is a small connector that passes updates between your team's
devices. It's how a phone and a laptop — or two volunteers across town — see the
same org. Everything is still local-first: the relay just shuttles messages;
each device holds the whole dataset.

## The default: the community relay

Out of the box, new orgs use the **maintainers' community relay**
(`wss://subduction.sync.inkandswitch.com`, an [Ink & Switch
Subduction](https://www.inkandswitch.com/) sync server). That's why you can
create an org and invite people immediately with nothing to configure.

**What the relay can and can't do.** A relay can't add itself to your team, and
your devices only accept updates from peers on your roster. But a relay decides
who may read a document from the access rules attached to that document, and
because updates aren't end-to-end encrypted yet, today's documents carry none.
So the community relay will hand what it stores to anyone who asks for it by
address — and so would any other relay, including one you run. Your roster
governs what your *devices* serve each other; it does not govern what a relay
serves. So:

> For anything sensitive — real names, phone numbers, addresses — **run your own
> relay** rather than the shared one. Your community, your infrastructure.

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

## Pinning the relay's key

Each device trusts a relay by its key. The first time you connect to a new
relay, the app **trusts it on first use** and pins its key, so later sessions
verify they're talking to the same relay.

When **joining** an org, if you already know the relay's key you can set it in
the **Relay key** field on the Join screen's Advanced panel (or `--relay-peer
<hex>` on `org join` / `sync`) to skip the trust-on-first-use step. When you
**create** a new org there's no Relay key field — the app pins the relay's key
automatically on first connect.

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

**Leave the default `--auth keyhive` mode on.** The alternative, `--auth open`,
disables access control entirely and is meant only for testing sync. Keeping
the default costs nothing and is what will enforce access once encryption ships.

Be clear about what running your own relay buys you *today*, though: not
secrecy. Because the toolkit doesn't encrypt document contents yet, your relay
holds readable data and will serve it to anyone who asks by address — the
default `--auth keyhive` mode can only enforce access on documents that carry
access rules, and today's don't. What you get is that the machine is **yours**:
you choose who can reach it, you can put it behind a VPN or firewall, and no
shared server holds your community's information. Once end-to-end encryption
ships (see [Security & trust](security-and-trust.md)) the relay will hold
ciphertext it cannot read, and this caveat goes away.

If you'd rather not run any relay, an org works fully **offline on a single
device** — just leave the relay blank. You can add sync later without losing
anything.

---

Back to the [README](../README.md) · [Configure your org](configure-your-org.md)
· [Security & trust](security-and-trust.md)
