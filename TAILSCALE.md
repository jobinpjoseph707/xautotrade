# Remote access via Tailscale

Your laptop must still be on with `npm run dev` running. Tailscale only removes the
"same WiFi" requirement; no router port-forwarding is needed.

## 1. Install

**Windows laptop**
1. Install from https://tailscale.com/download (or `winget install Tailscale.Tailscale`).
2. Sign in (Google/Microsoft/GitHub). Note which account you used.

**Phone**
1. Install the Tailscale app (Play Store / App Store), sign in with the SAME account.
2. Toggle Tailscale ON. Expo Go / the XAutoTrade app needs no changes to install.

## 2. Find the laptop's address

- Tailscale app on the phone > Machines > tap the laptop: shows `100.x.y.z` and its
  MagicDNS name (e.g. `cracker007.tailnet-name.ts.net`).
- Or on the laptop: `tailscale ip -4` in a terminal.

Server address to use in the app: `http://100.x.y.z:4000` (or the MagicDNS name).
Keep `http://` and `:4000`; the tunnel itself is WireGuard-encrypted.

## 3. App configuration

The Connect screen now stores two addresses plus a mode:
- **Home WiFi**: `http://192.168.1.2:4000`
- **Tailscale**: `http://100.x.y.z:4000`
- **Connect via**: Auto (tries WiFi for 2.5s, then Tailscale), Home WiFi, or Tailscale.

No code edits needed to switch. The API key is the same for both.

## 4. Authentication

Unchanged. Every `/api` request needs `x-api-key` (or `?key=`), and `/ws` needs
`?key=`, regardless of transport. Only `/api/health` is open (it returns status, no
account data). Do NOT add a "trust Tailscale IPs" bypass.

## 5. Firewall rule

The existing rule:
`netsh advfirewall firewall add rule name="XAutoTrade" dir=in action=allow protocol=TCP localport=4000`
applies to all profiles and all sources, so it already admits Tailscale traffic
(Windows may class the Tailscale adapter as Public; a profile-less rule still matches).
Tighter alternative, only your LAN and your tailnet (Tailscale CGNAT range):

```
netsh advfirewall firewall delete rule name="XAutoTrade"
netsh advfirewall firewall add rule name="XAutoTrade" dir=in action=allow protocol=TCP localport=4000 remoteip=LocalSubnet,100.64.0.0/10
```

Run in an Administrator terminal.

## 6. Manual test checklist

Setup: know the LAN URL, the Tailscale URL, and the API key.

| # | Setup | Action | Expected |
|---|-------|--------|----------|
| 1 | Phone on WiFi, laptop on same WiFi, Tailscale off | Mode Home WiFi, Connect | Connects, dashboard loads |
| 2 | Same, Tailscale ON | Mode Tailscale, Connect | Connects via 100.x address |
| 3 | Phone on cellular, laptop on WiFi, Tailscale ON | Mode Tailscale (or Auto) | Connects; Auto skips WiFi after ~2.5s timeout |
| 4 | Phone on cellular | Mode Home WiFi | Fails (expected: LAN unreachable) |
| 5 | Either path | Wrong API key | Rejected with "Invalid or missing API key." |
| 6 | Either path | Correct key | Accepted; live bot updates arrive over WebSocket |
| 7 | Browser on phone | `<url>/api/account` with no key | 401 |
| 8 | Browser on phone | `<url>/api/health` | JSON `status: up` (no key needed) |

### Telling failures apart

| Symptom | Meaning | Check |
|---------|---------|-------|
| `/api/health` loads, app says invalid key | Server up, tunnel up, wrong key | Re-copy key from server console |
| `/api/health` times out on Tailscale URL, but the laptop shows online in the Tailscale app | Server is off or firewall blocks 4000 | Is `npm run dev` running? Check the netsh rule |
| `/api/health` times out AND laptop shows offline/idle in the Tailscale app, or phone's Tailscale is off | Tunnel is down | Toggle Tailscale on both; laptop asleep? |
| Immediate "connection refused" / "network request failed" on the LAN URL from cellular | Wrong network for that URL | Use Tailscale mode |
| Works by IP but not by MagicDNS name | MagicDNS off or wrong name | Use the 100.x IP, enable MagicDNS in the admin console |
| Loads instantly on WiFi with Auto, slow on cellular | Normal: Auto waits out the WiFi probe | Choose Tailscale mode to skip it |

Quick discriminator: from the phone browser open `http://<tailscale-ip>:4000/api/health`.
JSON = server + tunnel OK. Timeout = server off or tunnel down (check the Tailscale app
status of the laptop to split those). Wrong-URL typos give an instant DNS/refused error.
