# Reaching Atlas from outside the house

> 2026-08-27 16:10 UTC — initial version.

Revision history:

- 2026-08-27 16:10 UTC — created; dedicated Cloudflare tunnel + Cloudflare Access, PWA and
  native app both reaching the same origin.

Atlas binds to `127.0.0.1` and is meant to. This document is about the one
supported way to reach it from anywhere else: an **outbound** tunnel to
Cloudflare, with **Cloudflare Access** deciding who gets through.

Nothing new is opened on the host. `cloudflared` dials out, and Cloudflare
dials back down the same connection — so `ATLAS_BIND` stays on loopback and
there is no port to find, scan, or forget to close.

## The shape of it

```
  phone / browser                Cloudflare edge            this Mac
  ---------------                ---------------            --------
  https://<host>       ──▶  Access: who are you?  ──▶  cloudflared ──▶ ui (nginx)
                              │                                            │
                              │ email OTP (browser)                   /api │
                              │ service token (native app)                 ▼
                              └── no answer ⇒ never reaches the origin     api
```

Two independent layers, and both have to pass:

| Layer | Checks | Fails with |
|---|---|---|
| Cloudflare Access | *may this client reach Atlas at all* | 302 to the login page (browser), 401 (service token) |
| Atlas `ATLAS_TOKEN` | *may this request use the API* | 401 from the API itself |

They are deliberately not the same secret. Access can be revoked centrally
without touching the stack; the bearer token keeps the API closed even to
something that has already passed the edge.

**A tunnelled request is never loopback.** It arrives at the API through nginx,
so the API sees nginx's bridge address, and `ATLAS_TOKEN` is enforced on every
one of them. That is also why setting `ATLAS_TOKEN` makes the *local* web UI
ask for it: the browser at `127.0.0.1:8712` also reaches the API through nginx.

## Setting it up

1. Put this deployment's identity in `.env` (gitignored — **this repository is
   public**, so none of it belongs in `config/atlas.defaults.env`):

   ```
   ATLAS_PUBLIC_HOSTNAME=atlas.example.com
   ATLAS_ACCESS_EMAILS=you@example.com
   ```

2. Provision Cloudflare. Needs credentials in the environment
   (`CLOUDFLARE_API_TOKEN`, or `CLOUDFLARE_EMAIL_ACCOUNT` +
   `CLOUDFLARE_GLOBAL_API_KEY`), typically from a secrets manager:

   ```
   doppler run -p <project> -c <config> -- make tunnel-setup
   ```

   It is idempotent — it creates or repairs the tunnel, its ingress rule, the
   proxied DNS record, the Access application, the owner policy, and a service
   token for the native app. It prints `CLOUDFLARE_TUNNEL_TOKEN` and a
   suggested `ATLAS_TOKEN`; put both in `.env`.

3. `make restart-build` so the API and MCP pick up `ATLAS_TOKEN`, then
   `make public-up`.

`make tunnel-status` shows what is actually live. `make public-down` takes
Atlas off the internet without stopping it; `make tunnel-teardown` removes the
Cloudflare side entirely.

## The native app

Access signs people in through a browser, which an app has no way to complete.
Cloudflare's answer is a **service token**: two headers, checked at the edge.
`make tunnel-setup` mints one and prints it **once** — Cloudflare has no route
that reads the secret back, so a lost secret means deleting the token and
minting another.

On the phone: **Settings → Cloudflare Access**, paste the Client Id and Client
Secret (stored in the Keychain/Keystore), and set **Server** to the public
address. The bearer token goes in the field above it. *Test connection* names
which layer refused, because "401" on its own sends people to re-enter a token
that was already correct.

## The PWA

The installed web app authenticates with an ordinary Access session — the login
happens in the browser, once per `ATLAS_ACCESS_SESSION`.

One non-obvious requirement: the manifest link carries
`crossorigin="use-credentials"`. A manifest is fetched with credentials
omitted by default, so behind Access it would come back as the login page and
the browser would quietly treat the app as not installable. The alternative —
an Access bypass rule on the manifest path — punches a hole in the perimeter to
solve what is really a request-mode problem.

The service worker never caches a response it cannot prove came from Atlas
(`response.type === 'basic'`, not redirected), so an expired Access session
cannot pin Cloudflare's login page in the cache in place of the app.

## If it stops working

- `make public-logs` — the tunnel's own log. Connection and origin errors show
  up here, not in `make logs`.
- `make tunnel-status` — is the DNS record still proxied, is the ingress still
  pointing at `ui`, do the Access policies still exist.
- A 502 through the tunnel with a healthy stack usually means the `ui`
  container was recreated and `cloudflared` is still holding the old address.
  Restart `cloudflared` (`make public-down && make public-up`).
