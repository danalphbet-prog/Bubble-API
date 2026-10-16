# Bubble API MVP v1.2.0 — Architecture

## Current scope

This package is the Bedrock-first continuation of the Bubble API v1.1 design.

- Central Bubble API is the logical authority.
- Two or more independent Bedrock Dedicated Server (BDS) instances can join the same Bubble.
- Each BDS/Add-On publishes its local player state and receives remote states.
- Transport is HTTP polling, not WebSocket.
- Runtime state is in memory only.
- Default Bubble `n25` is 64×32×64 BU.
- Horizontal Bubble size ceiling is 256×256 BU; height is defined separately by the manifest.
- Recommended sync interval: 200 ms (~5 Hz).
- AOI: 96 BU, maximum 64 remote players returned per sync.
- Player state TTL: 2.5 s.

## Components

```text
Bedrock player A
    │
    ▼
BDS A + Bubble Add-On
    │ @minecraft/server-net HTTP
    ▼
┌───────────────────────────────┐
│        Bubble API             │
│                               │
│ Session/Auth                  │
│ Bubble Registry / Manifest    │
│ Presence + Realtime State     │
│ AOI filtering                 │
│ TTL / cleanup                 │
│ Rules / bounds validation     │
└───────────────────────────────┘
    ▲
    │ @minecraft/server-net HTTP
BDS B + Bubble Add-On
    ▲
    │
Bedrock player B
```

The remote player is not a real network player inside the other BDS. The receiving Add-On represents that user as a proxy/entity and interpolates its state locally.

## Connection flow

1. BDS starts.
2. Add-On calls `POST /v1/sessions/register` with `server_id`, `server_key`, and `instance_id`.
3. API validates the server secret and returns a temporary `session_token`.
4. Add-On reads the Bubble catalog/manifest.
5. When local player enters a Bubble, Add-On calls `/join`.
6. Every ~200 ms the Add-On calls `/sync` with the local player's current state.
7. The API stores the newest state in memory and returns remote players in the same Bubble and AOI.
8. Add-On creates or updates remote proxy entities and interpolates between samples.
9. Missing updates older than 2.5 s disappear naturally through TTL cleanup.
10. When the player leaves, Add-On calls `/leave`; when BDS shuts down, it closes the session.

## Movement state

MVP publishes:

```json
{
  "player": {
    "id": "bedrock:PLAYER_UUID",
    "name": "PlayerA",
    "position": [12.5, 4.0, 31.25],
    "rotation": { "yaw": 87.0, "pitch": -4.0 },
    "animation": "walk",
    "flags": {
      "sprinting": false,
      "sneaking": false,
      "jumping": false,
      "grounded": true
    }
  }
}
```

The API returns `remotes[]` with the same render-relevant state. The Add-On should interpolate; it should not snap the proxy directly to each network sample.

## Manifest authority

The API manifest defines:

- identity: `bubble_id`, `nid`, `uid`
- protocol and manifest version
- seed and generator version
- coordinate system in Bubble Units (BU)
- dimensions/bounds
- spawn position
- chunk size
- game mode
- player limit
- persistence flag
- safety/gameplay rules
- portal definitions

The API decides the logical Bubble dimensions. The Add-On/host renders or enforces them locally.

## Security model

- A permanent `server_key` belongs to the BDS instance, not to a player/client.
- `server_key` is used only to register a session.
- Registration returns a random temporary bearer token.
- `join`, `leave`, `sync`, catalog and manifest use that bearer token.
- Join is mandatory before sync.
- Positions are validated against Bubble bounds.
- Sync and registration have basic in-memory rate limits.
- Sessions and player presence expire automatically.
- Creative/build/break/inventory/PVP restrictions are declared by manifest.
- The API cannot by itself stop a modified local BDS from cheating. Enforcement of Adventure/Creative and native actions must also happen in the BDS/Add-On/Adam host layer. For public production, signed server identity + persistent audit/Redis/database should be the next security upgrade.

## Why HTTP polling in the MVP

Polling is intentionally simple and compatible with the BDS HTTP path. At 200 ms, movement replication is around 5 samples/s. Interpolation hides most of that network coarseness.

For a later production version, WebSocket/UDP-like realtime, Redis presence, durable identities, delta compression and regional relays are natural upgrades.
