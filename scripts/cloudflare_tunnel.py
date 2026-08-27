#!/usr/bin/env python3
"""Provision (or inspect) Atlas's own Cloudflare tunnel and Access application.

Atlas gets a DEDICATED tunnel rather than a route on an existing one. The
tunnel container then dials the compose service directly (`http://ui:80`), so
nothing has to be published on the host and no other project's nginx or tunnel
config is touched — a mistake here cannot take an unrelated site down.

Everything is find-or-create: running it twice changes nothing, and it is the
only supported way to reproduce this setup on another machine.

  status    show tunnel, DNS, ingress, Access app and policies
  setup     create/repair all of the above, print the secrets to store
  teardown  delete the tunnel, its DNS record and the Access app

Credentials come from the environment (never a file in this repo):
  CLOUDFLARE_EMAIL_ACCOUNT + CLOUDFLARE_GLOBAL_API_KEY, or CLOUDFLARE_API_TOKEN
Configuration comes from config/atlas.defaults.env via the Makefile:
  ATLAS_PUBLIC_HOSTNAME, ATLAS_TUNNEL_NAME, ATLAS_ACCESS_EMAILS,
  ATLAS_TUNNEL_ORIGIN, ATLAS_ACCESS_SESSION
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import urllib.error
import urllib.request

CF = "https://api.cloudflare.com/client/v4"


def env(name: str, default: str | None = None) -> str:
    v = os.environ.get(name) or default
    if v is None:
        sys.exit(f"missing required setting: {name}")
    return v


def auth_headers() -> dict[str, str]:
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if token:
        return {"Authorization": f"Bearer {token}"}
    email = os.environ.get("CLOUDFLARE_EMAIL_ACCOUNT")
    key = os.environ.get("CLOUDFLARE_GLOBAL_API_KEY")
    if email and key:
        return {"X-Auth-Email": email, "X-Auth-Key": key}
    sys.exit(
        "no Cloudflare credentials in the environment — set CLOUDFLARE_API_TOKEN, "
        "or CLOUDFLARE_EMAIL_ACCOUNT + CLOUDFLARE_GLOBAL_API_KEY"
    )


def api(method: str, path: str, body: dict | list | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        CF + path,
        data=data,
        method=method,
        headers={**auth_headers(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:600]
        sys.exit(f"cloudflare {method} {path} -> HTTP {e.code}\n{detail}")
    if not payload.get("success", False):
        sys.exit(f"cloudflare {method} {path} failed: {payload.get('errors')}")
    return payload


# --- lookups -----------------------------------------------------------------

def account_id() -> str:
    """CLOUDFLARE_ACCOUNT_ID if given, else the only account the token can see.

    Resolved rather than required: one more value to copy between machines is
    one more chance to point this at the wrong account.
    """
    explicit = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if explicit:
        return explicit
    accounts = api("GET", "/accounts?per_page=50")["result"]
    if len(accounts) != 1:
        sys.exit(
            f"{len(accounts)} accounts visible — set CLOUDFLARE_ACCOUNT_ID to choose: "
            + ", ".join(f"{a['name']}={a['id']}" for a in accounts)
        )
    return accounts[0]["id"]


def zone_id(account: str, hostname: str) -> tuple[str, str]:
    """Zone id + apex for the hostname, resolved rather than configured."""
    zones = api("GET", f"/zones?account.id={account}&per_page=200")["result"]
    match = max(
        (z for z in zones if hostname == z["name"] or hostname.endswith("." + z["name"])),
        key=lambda z: len(z["name"]),
        default=None,
    )
    if not match:
        sys.exit(f"no zone in this account covers {hostname}")
    return match["id"], match["name"]


def find_tunnel(account: str, name: str) -> dict | None:
    got = api("GET", f"/accounts/{account}/cfd_tunnel?name={name}&is_deleted=false")["result"]
    return got[0] if got else None


def find_dns(zone: str, hostname: str) -> dict | None:
    got = api("GET", f"/zones/{zone}/dns_records?name={hostname}")["result"]
    return got[0] if got else None


def find_access_app(account: str, hostname: str) -> dict | None:
    for a in api("GET", f"/accounts/{account}/access/apps")["result"]:
        if a.get("domain") == hostname:
            return a
    return None


def find_service_token(account: str, name: str) -> dict | None:
    for t in api("GET", f"/accounts/{account}/access/service_tokens")["result"]:
        if t.get("name") == name:
            return t
    return None


# --- setup steps -------------------------------------------------------------

def ensure_tunnel(account: str, name: str) -> tuple[dict, str | None]:
    """Returns (tunnel, token). The token is only readable via its own route."""
    t = find_tunnel(account, name)
    if t:
        print(f"  tunnel {name}: exists ({t['id']})")
    else:
        # A locally-managed secret would mean a credentials file on disk; a
        # remotely-managed tunnel keeps its config in Cloudflare and hands the
        # container a single token, which is what compose passes it.
        t = api(
            "POST",
            f"/accounts/{account}/cfd_tunnel",
            {"name": name, "tunnel_secret": None, "config_src": "cloudflare"},
        )["result"]
        print(f"  tunnel {name}: CREATED ({t['id']})")
    token = api("GET", f"/accounts/{account}/cfd_tunnel/{t['id']}/token")["result"]
    return t, token


def ensure_ingress(account: str, tunnel: str, hostname: str, origin: str) -> None:
    """One hostname to the compose service, everything else a hard 404."""
    want = [
        {"hostname": hostname, "service": origin},
        {"service": "http_status:404"},
    ]
    current = api("GET", f"/accounts/{account}/cfd_tunnel/{tunnel}/configurations")["result"]
    if (current.get("config") or {}).get("ingress") == want:
        print(f"  ingress: already {hostname} -> {origin}")
        return
    api("PUT", f"/accounts/{account}/cfd_tunnel/{tunnel}/configurations",
        {"config": {"ingress": want}})
    print(f"  ingress: SET {hostname} -> {origin}")


def ensure_dns(zone: str, hostname: str, tunnel: str) -> None:
    target = f"{tunnel}.cfargotunnel.com"
    rec = find_dns(zone, hostname)
    body = {
        "type": "CNAME",
        "name": hostname,
        "content": target,
        # Proxied is not cosmetic: an unproxied record would expose the tunnel
        # endpoint directly and skip Access entirely.
        "proxied": True,
        "comment": "Atlas — managed by scripts/cloudflare_tunnel.py",
    }
    if rec and rec["type"] == "CNAME" and rec["content"] == target and rec["proxied"]:
        print(f"  dns: {hostname} already -> {target} (proxied)")
        return
    if rec:
        api("PATCH", f"/zones/{zone}/dns_records/{rec['id']}", body)
        print(f"  dns: UPDATED {hostname} -> {target}")
    else:
        api("POST", f"/zones/{zone}/dns_records", body)
        print(f"  dns: CREATED {hostname} -> {target}")


def ensure_access(account: str, hostname: str, emails: list[str], session: str,
                  token_name: str) -> tuple[str, str] | None:
    """Access app + two policies. Returns new service-token creds if minted."""
    app = find_access_app(account, hostname)
    body = {
        "name": f"Atlas ({hostname})",
        "domain": hostname,
        "type": "self_hosted",
        "session_duration": session,
        # Without this a non-browser client gets a 302 to the login page and
        # has to guess why its JSON parse failed. The native app needs a 401.
        "service_auth_401_redirect": True,
        "app_launcher_visible": False,
        "auto_redirect_to_identity": False,
    }
    if app:
        app = api("PUT", f"/accounts/{account}/access/apps/{app['id']}", body)["result"]
        print(f"  access app: updated ({app['id']})")
    else:
        app = api("POST", f"/accounts/{account}/access/apps", body)["result"]
        print(f"  access app: CREATED ({app['id']})")
    app_id = app["id"]

    st = find_service_token(account, token_name)
    minted: tuple[str, str] | None = None
    if st:
        print(f"  service token {token_name}: exists ({st['client_id']})")
    else:
        # The secret is returned exactly once, at creation. There is no route
        # that reads it back, so it has to be captured here or rotated.
        st = api("POST", f"/accounts/{account}/access/service_tokens",
                 {"name": token_name, "duration": "8760h"})["result"]
        minted = (st["client_id"], st["client_secret"])
        print(f"  service token {token_name}: CREATED ({st['client_id']})")

    want = [
        {
            "name": "Atlas owner",
            "decision": "allow",
            "precedence": 1,
            "include": [{"email": {"email": e}} for e in emails],
        },
        {
            # non_identity: a service token carries no human identity, so an
            # `allow` policy would never match it.
            "name": "Atlas native app",
            "decision": "non_identity",
            "precedence": 2,
            "include": [{"service_token": {"token_id": st["id"]}}],
        },
    ]
    existing = {p["name"]: p for p in
                api("GET", f"/accounts/{account}/access/apps/{app_id}/policies")["result"]}
    for p in want:
        if p["name"] in existing:
            api("PUT", f"/accounts/{account}/access/apps/{app_id}/policies/"
                       f"{existing[p['name']]['id']}", p)
            print(f"  policy {p['name']}: updated")
        else:
            api("POST", f"/accounts/{account}/access/apps/{app_id}/policies", p)
            print(f"  policy {p['name']}: CREATED")
    return minted


# --- commands ----------------------------------------------------------------

def settings() -> dict[str, str]:
    hostname = env("ATLAS_PUBLIC_HOSTNAME")
    return {
        "hostname": hostname,
        "tunnel_name": env("ATLAS_TUNNEL_NAME", "atlas"),
        "origin": env("ATLAS_TUNNEL_ORIGIN", "http://ui:80"),
        "session": env("ATLAS_ACCESS_SESSION", "720h"),
        "emails": env("ATLAS_ACCESS_EMAILS"),
        "token_name": env("ATLAS_ACCESS_TOKEN_NAME", "atlas-native-app"),
    }


def cmd_status() -> None:
    s = settings()
    account = account_id()
    zone, apex = zone_id(account, s["hostname"])
    print(f"account {account}  zone {apex} ({zone})")
    t = find_tunnel(account, s["tunnel_name"])
    print(f"  tunnel {s['tunnel_name']}: {t['id'] if t else 'ABSENT'}"
          + (f"  status={t.get('status')}" if t else ""))
    if t:
        cfg = api("GET", f"/accounts/{account}/cfd_tunnel/{t['id']}/configurations")["result"]
        for r in (cfg.get("config") or {}).get("ingress", []):
            print(f"    {r.get('hostname', '(catch-all)')} -> {r.get('service')}")
    rec = find_dns(zone, s["hostname"])
    print(f"  dns {s['hostname']}: "
          + (f"{rec['type']} {rec['content']} proxied={rec['proxied']}" if rec else "ABSENT"))
    app = find_access_app(account, s["hostname"])
    print(f"  access app: {app['id'] if app else 'ABSENT'}")
    if app:
        for p in api("GET", f"/accounts/{account}/access/apps/{app['id']}/policies")["result"]:
            print(f"    policy {p['name']}: {p['decision']}")
    st = find_service_token(account, s["token_name"])
    print(f"  service token {s['token_name']}: {st['client_id'] if st else 'ABSENT'}")


def cmd_setup() -> None:
    s = settings()
    account = account_id()
    zone, apex = zone_id(account, s["hostname"])
    emails = [e.strip() for e in s["emails"].split(",") if e.strip()]
    print(f"provisioning {s['hostname']} in zone {apex}")

    tunnel, tunnel_token = ensure_tunnel(account, s["tunnel_name"])
    ensure_ingress(account, tunnel["id"], s["hostname"], s["origin"])
    ensure_dns(zone, s["hostname"], tunnel["id"])
    minted = ensure_access(account, s["hostname"], emails, s["session"], s["token_name"])

    print("\n--- store these in .env (gitignored), then `make restart-build` ---")
    print(f"CLOUDFLARE_TUNNEL_TOKEN={tunnel_token}")
    if not os.environ.get("ATLAS_TOKEN"):
        print(f"ATLAS_TOKEN={secrets.token_urlsafe(32)}")
    if minted:
        print("\n--- native app: Settings > Cloudflare Access (shown ONCE) ---")
        print(f"CF-Access-Client-Id     {minted[0]}")
        print(f"CF-Access-Client-Secret {minted[1]}")
    else:
        print(f"\nservice token {s['token_name']} already exists; its secret cannot be "
              "read back — delete it here and re-run setup to rotate.")


def cmd_teardown() -> None:
    s = settings()
    account = account_id()
    zone, _ = zone_id(account, s["hostname"])
    app = find_access_app(account, s["hostname"])
    if app:
        api("DELETE", f"/accounts/{account}/access/apps/{app['id']}")
        print("  access app: deleted")
    rec = find_dns(zone, s["hostname"])
    if rec:
        api("DELETE", f"/zones/{zone}/dns_records/{rec['id']}")
        print("  dns: deleted")
    t = find_tunnel(account, s["tunnel_name"])
    if t:
        api("DELETE", f"/accounts/{account}/cfd_tunnel/{t['id']}")
        print("  tunnel: deleted")
    print("service token left in place — it is not hostname-specific.")


COMMANDS = {"status": cmd_status, "setup": cmd_setup, "teardown": cmd_teardown}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd not in COMMANDS:
        sys.exit(f"usage: {sys.argv[0]} [{' | '.join(COMMANDS)}]")
    COMMANDS[cmd]()
