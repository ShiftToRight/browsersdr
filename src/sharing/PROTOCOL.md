# Live sharing client contract

The receiver application does not require a server. Live sharing is an optional
integration with a separately installed signaling service and STUN/TURN relay.
No server implementation, deployment settings or long-term credentials belong in
this app repository. A normal checkout can build and run the receiver without them.

The browser sends same-origin JSON POST requests to `/api/v1/sharing`, with
`credentials: omit` and `Cache-Control: no-store` responses. Session tokens, keys,
SDP and ICE candidates belong in request bodies, never query strings or logs.
An optional `BROWSERSDR_SHARING_PROXY=http://127.0.0.1:8788` development/preview
environment variable forwards this route to a separately running service.

| Action | Request | Response |
| --- | --- | --- |
| create | `action` | `key`, host `token`, `expires`, `mode`, `iceServers`, `iceTransportPolicy` |
| signal | `token`, `kind`, `value` | `ok` |
| join | `key` | guest access plus initial `events` |
| events | `token`, `after` | `events` or HTTP204 after a bounded wait |
| leave | `token` | `ok`; revoke room and wake the other peer with410 |

Access tokens are distinct random48hexcharacters. Keys have12characters from
`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`; ignore case, whitespace and hyphens. Keys are
single use, expire after10minutes, and grant listener access to one guest. The
host role can send one offer; the guest can send one matching answer. Each role
may send at most128ICE candidates including the terminal null candidate, after
its description. SDP retains the versioned `browsersdr-peer-prototype-v1` wrapper.

An event has an integer `sequence`, `kind` (`offer`, `answer`, `candidate`) and
`value`. Per-recipient sequences start at1; clients process in order and
acknowledge with the last consumed cursor. The service retains unacknowledged
events across a repeated poll and rejects stale/future cursors. Description
values are bounded JSON strings; candidate values are sanitized
`RTCIceCandidateInit` objects or null. No receiver commands are carried here.

`mode: internet` must supply authenticated TURN/UDP and TURN/TLS URLs and
short-lived credentials; local tests may use `mode: local` with no relay. Apply
configuration before gathering, then send SDP and trickle candidates. ICE chooses
a usable direct or relay path with `iceTransportPolicy: all`; `relay` is available
for deployment privacy policy and forced-relay validation. Both audio and data
channels use the selected encrypted WebRTC connection. TURN does not process RF.

Sessions end within2hours. Continue polling after setup for revocation/lifecycle;
Stop/source change closes the peer and room while local reception continues.
Service errors receive a15second retry grace after detection; an outstanding
poll itself can take up to30seconds to fail. Peer disconnection gets8seconds to
recover before ending. Rejoining requires a new session. A service restart loses
its ephemeral room state. Credential expiry is not a promise to retract traffic
already delivered or immediately invalidate every TURN allocation.

Public unit/browser tests use a clearly identified signaling fixture; WebRTC
media remains real. Release qualification must also run
`BSD_E2E_SHARING_REAL=1` against the separately supplied actual service, and
`BSD_E2E_SHARING_RELAY=1` with server-enforced relay policy to prove fallback.
No optional skip converts missing private integration into a pass. Physical RF,
WAN, TLS-certificate/firewall and provider capacity acceptance remain separate.
