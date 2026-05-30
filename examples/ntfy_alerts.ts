import {
    LogLevel,
    LogService,
    MatrixClient,
    NtfyMatrixBridge,
    RichConsoleLogger,
    SimpleFsStorageProvider,
} from "../src";

LogService.setLogger(new RichConsoleLogger());
LogService.setLevel(LogLevel.INFO);

let creds = null;
try {
    creds = require("../../examples/storage/ntfy.creds.json");
} catch (e) {
    // ignore
}

const homeserverUrl = creds?.['homeserverUrl'] ?? "http://localhost:8008";
const accessToken = creds?.['accessToken'] ?? 'YOUR_TOKEN';
const ntfyTopic = creds?.['ntfyTopic'] ?? "my-secret-alerts-topic";
const alertTarget = creds?.['alertTarget'] ?? "@admin:localhost";

const storage = new SimpleFsStorageProvider("./examples/storage/ntfy.json");
const client = new MatrixClient(homeserverUrl, accessToken, storage);

(async function() {
    // The bridge forwards every ntfy notification into a hidden service room,
    // invites the human who should receive the alerts, and redacts each alert
    // after it has been around for a day so they don't pile up in the timeline.
    const bridge = new NtfyMatrixBridge(client, {
        ntfy: {
            topic: ntfyTopic,
            // baseUrl: "https://ntfy.sh",       // self-hosted? point this at your server
            // token: "tk_...",                  // for protected topics
        },
        roomName: "System Alerts",
        roomTopic: "Automated alerts bridged from ntfy. Managed automatically.",
        inviteUserIds: [alertTarget],
        priorityThreshold: 3, // ignore "min"/"low" priority noise
        cleanup: {
            ttlMs: 24 * 60 * 60 * 1000, // keep alerts for 24h
            mode: "redact",             // or "archive" with an archiveRoomId
        },
    });

    const roomId = await bridge.start();
    LogService.info("ntfy_alerts", `Bridging ntfy topic "${ntfyTopic}" into ${roomId}`);
    LogService.info("ntfy_alerts", `Publish a test alert with:  curl -d "hello from ntfy" ntfy.sh/${ntfyTopic}`);

    // Keep the process alive. In a real deployment you'd also call client.start()
    // if the bot needs to react to room events (e.g. accepting its own invite).
})();
