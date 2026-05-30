This SDK can bridge [ntfy](https://ntfy.sh) push notifications into Matrix so that operational alerts land in a dedicated, hidden "service" room instead of cluttering a user's normal chats. It comes with three pieces:

- `NtfyClient` — a streaming subscriber for an ntfy topic.
- `NtfyMatrixBridge` — forwards every ntfy notification into a hidden Matrix room.
- `AlertCleanupService` — automatically redacts (or archives) alerts after a configurable lifetime so they don't linger in history.

The goal is to get system alerts to ring through as **mobile push notifications** without them showing up as **unread messages** in the user's main inbox. The SDK handles the bridging and cleanup; the push behaviour is achieved with a couple of [push rules](https://spec.matrix.org/latest/client-server-api/#push-rules), described at the bottom of this guide.

## Quick start

```typescript
import { MatrixClient, NtfyMatrixBridge, SimpleFsStorageProvider } from "matrix-bot-sdk";

const client = new MatrixClient("https://matrix.example.org", "ACCESS_TOKEN", new SimpleFsStorageProvider("./bot.json"));

const bridge = new NtfyMatrixBridge(client, {
    ntfy: {
        topic: "my-secret-alerts-topic",
        // baseUrl: "https://ntfy.example.org", // for a self-hosted ntfy server
        // token: "tk_...",                     // for protected topics
    },
    roomName: "System Alerts",
    inviteUserIds: ["@admin:example.org"], // the human who should get the alerts
    priorityThreshold: 3,                  // skip min/low priority noise
    cleanup: {
        ttlMs: 24 * 60 * 60 * 1000,        // keep alerts for 24 hours
        mode: "redact",                    // or "archive"
    },
});

const roomId = await bridge.start();
console.log(`Forwarding ntfy alerts into ${roomId}`);
```

Publish a test alert and watch it appear in the room:

```bash
curl -d "Disk space low on db-01" ntfy.sh/my-secret-alerts-topic
```

A runnable version of this lives in `examples/ntfy_alerts.ts` (`yarn example:ntfy`).

## The hidden service room

When you don't pass a `roomId`, the bridge creates a room for you and remembers it in the account's `world.ixo.ntfy.bridge` account data, so restarts reuse the same room rather than creating duplicates. The room is created as:

- **private** (`visibility: "private"`) so it never appears in the public room directory, and
- marked with a `world.ixo.ntfy.service_room` state event so clients/automation can recognise and hide it.

You can also point the bridge at an existing room with the `roomId` option.

Every forwarded alert is a normal `m.room.message` (with `msgtype: "m.notice"` by default) carrying two extra fields:

- `world.ixo.ntfy.alert: true` — a flag push rules can match on (see below), and
- `world.ixo.ntfy.meta` — the originating topic, priority, tags and click URL.

## Automatic cleanup

The `AlertCleanupService` keeps a small ledger of posted alerts in the room's account data (`world.ixo.ntfy.alert_ledger`) and periodically redacts those older than `ttlMs`. Because the ledger is stored server-side, cleanup survives restarts and never has to scan room history.

Two modes are available:

- `redact` (default) — removes the alert from the room entirely.
- `archive` — copies the alert into an `archiveRoomId` first, then redacts it from the live room. Use this when you need a durable record but still want the user's active room kept tidy.

```typescript
cleanup: {
    ttlMs: 7 * 24 * 60 * 60 * 1000, // a week
    mode: "archive",
    archiveRoomId: "!alerts-archive:example.org",
}
```

Pass `cleanup: false` to disable cleanup entirely.

## Push rules: ring on mobile, stay out of the inbox

By default Matrix gives every message in a joined room an unread/notification count, and `m.notice` messages don't generate a push at all. For a service room we want the *opposite*: a push notification on the user's phone, but **no** unread badge polluting their main inbox.

This is done with two push rules on the **receiving user's** account (the human you invited, not the bridge bot). Push rules are per-user account data and are set with the [push rules API](https://spec.matrix.org/latest/client-server-api/#push-rules). With a `MatrixClient` for that user you can set them via `doRequest`:

### 1. Push (with sound) but don't mark as unread

Add an `override` rule that matches the bridge's content flag. The `notify` action delivers the push; crucially we **omit** the `highlight` tweak and add `"sound"` only, so the event pushes to mobile without becoming a highlight in the inbox.

```typescript
await userClient.doRequest(
    "PUT",
    "/_matrix/client/v3/pushrules/global/override/world.ixo.ntfy.alert",
    null,
    {
        conditions: [
            { kind: "event_match", key: "content.world\\.ixo\\.ntfy\\.alert", pattern: "true" },
        ],
        actions: [
            "notify",
            { set_tweak: "sound", value: "default" },
        ],
    },
);
```

> Note: in the `event_match` `key`, dots in the content path are literal field separators, so the dots inside `world.ixo.ntfy.alert` are escaped as `world\.ixo\.ntfy\.alert`.

### 2. Keep the room out of unread counts

To stop the service room from contributing to the user's unread/badge counts, add a `room` rule scoped to the service room that uses the `dont_notify`-style tweaks but keeps the push from rule #1. The cleanest approach is to mark the room itself as low-priority and rely on rule #1 for the push:

```typescript
// Tag the service room as low priority for this user so clients sort/hide it.
await userClient.doRequest(
    "PUT",
    `/_matrix/client/v3/user/${encodeURIComponent(await userClient.getUserId())}/rooms/${encodeURIComponent(roomId)}/tags/m.lowpriority`,
    null,
    { order: 0.0 },
);
```

If your client still counts the room as unread, add a `room` push rule that suppresses the unread tweak while leaving the override push in place:

```typescript
await userClient.doRequest(
    "PUT",
    `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(roomId)}`,
    null,
    {
        actions: ["dont_notify"],
    },
);
```

Because override rules are evaluated **before** room rules, rule #1 still fires the mobile push, while the `room` rule above keeps the timeline from generating an unread badge in the user's main inbox.

### Why this works

Matrix evaluates push rules in priority order: `override` → `content` → `room` → `sender` → `underride`. The override rule (#1) wins for delivering the push, and the lower-priority `room` rule (#2) governs the unread/badge behaviour. Combined with the private, low-priority service room, the user gets a phone notification for every alert without the room ever surfacing as an unread conversation.
