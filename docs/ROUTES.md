# Bubble API MVP v1.2.0 — Routes

## Public

### `GET /`
Service metadata.

### `GET /healthz`
Health, uptime and in-memory counters.

### `GET /docs`
Small human-readable docs page.

### `GET /openapi.json`
OpenAPI route index.

## Session/Auth

### `POST /v1/sessions/register`
Registers one BDS instance.

Request:
```json
{
  "server_id": "bedrock-streamer-a",
  "server_key": "change-me-a",
  "instance_id": "bds-a-001",
  "platform": "bedrock",
  "metadata": { "label": "Streamer A" }
}
```

Response includes `session_token`, expiration, heartbeat interval and recommended poll interval.

### `POST /v1/sessions/heartbeat`
Bearer auth. Refreshes session activity.

### `DELETE /v1/sessions/{session_id}`
Bearer auth. Closes current session and removes its players.

## Bubble catalog

### `GET /v1/bubbles`
Bearer auth. Lists Bubble summaries.

### `GET /v1/bubbles/{bubble_id}`
Bearer auth. Full Bubble detail plus live player count.

### `GET /v1/bubbles/{bubble_id}/manifest`
Bearer auth. Authoritative manifest consumed by the Add-On/host.

### `GET /v1/bubbles/{bubble_id}/chunks/{cx}/{cz}`
Bearer auth. Returns deterministic chunk identity/metadata. MVP does not stream block arrays.

## Presence and realtime state

### `POST /v1/bubbles/{bubble_id}/join`
Bearer auth. Required before sync.

### `POST /v1/bubbles/{bubble_id}/sync`
Bearer auth. Publishes local movement and returns nearby remote players.

Request:
```json
{
  "player": {
    "id": "bedrock:uuid-a",
    "name": "PlayerA",
    "position": [10, 3, 20],
    "rotation": { "yaw": 90, "pitch": 0 },
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

Response:
```json
{
  "protocol": "bubble/1",
  "bubble_id": "n25",
  "server_time": 0,
  "tick": 42,
  "self": { "id": "bedrock:uuid-a", "revision": 8 },
  "remotes": [
    {
      "id": "bedrock:uuid-b",
      "name": "PlayerB",
      "platform": "bedrock",
      "server_id": "bedrock-streamer-b",
      "position": [13, 3, 21],
      "rotation": { "yaw": 270, "pitch": 3 },
      "animation": "idle",
      "flags": {
        "sprinting": false,
        "sneaking": false,
        "jumping": false,
        "grounded": true
      },
      "revision": 4,
      "updated_at": 0
    }
  ],
  "recommended_poll_ms": 200,
  "player_ttl_ms": 2500,
  "interpolation_hint_ms": 400
}
```

### `POST /v1/bubbles/{bubble_id}/leave`
Bearer auth. Removes all players owned by that session from the Bubble.

### `GET /v1/bubbles/{bubble_id}/snapshot`
Bearer auth + `x-bubble-admin-key` when configured. Debug/admin live snapshot.
