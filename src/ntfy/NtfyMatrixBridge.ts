import { MatrixClient } from "../MatrixClient";
import { LogService, extractRequestError } from "../logging/LogService";
import { NtfyClient, NtfyClientOptions } from "./NtfyClient";
import { NtfyMessage } from "./INtfyMessage";
import { AlertCleanupService, AlertCleanupOptions } from "./AlertCleanupService";

/**
 * The account data event type used to remember which room the bridge posts
 * alerts into. Storing this on the account means the bridge reuses the same
 * hidden room across restarts instead of creating a new one each time.
 * @category Ntfy alerts
 */
export const NTFY_BRIDGE_EVENT_TYPE = "world.ixo.ntfy.bridge";

/**
 * The state event type written into the service room to mark it as a managed
 * ntfy alert room. Clients and automation can match on this to hide the room
 * from the user's main room list.
 * @category Ntfy alerts
 */
export const NTFY_SERVICE_ROOM_MARKER = "world.ixo.ntfy.service_room";

/**
 * A content flag set on every forwarded alert event. Push rules can match on
 * `content.world.ixo.ntfy.alert` to deliver mobile pushes for these events
 * while keeping them out of the user's unread counts. See the "ntfy alerts"
 * tutorial for an example rule.
 * @category Ntfy alerts
 */
export const NTFY_ALERT_CONTENT_FLAG = "world.ixo.ntfy.alert";

/**
 * The result of formatting an ntfy message into Matrix message content.
 * @category Ntfy alerts
 */
export interface FormattedAlert {
    /**
     * The plain text body.
     */
    body: string;

    /**
     * The HTML formatted body, if any.
     */
    formatted_body?: string;
}

/**
 * Options for the {@link NtfyMatrixBridge}.
 * @category Ntfy alerts
 */
export interface NtfyMatrixBridgeOptions {
    /**
     * The ntfy subscription(s) to forward. Accepts ready-made {@link NtfyClient}
     * instances or plain options that will be turned into clients.
     */
    ntfy: NtfyClientOptions | NtfyClient | Array<NtfyClientOptions | NtfyClient>;

    /**
     * An existing room to post alerts into. If omitted, the bridge looks up a
     * previously created room from account data and, failing that, creates one
     * when `createRoomIfMissing` is enabled.
     */
    roomId?: string;

    /**
     * Whether to create a hidden service room when one isn't already known.
     * Defaults to true.
     */
    createRoomIfMissing?: boolean;

    /**
     * The name for a newly created service room. Defaults to "System Alerts".
     */
    roomName?: string;

    /**
     * The topic for a newly created service room.
     */
    roomTopic?: string;

    /**
     * User IDs to invite to a newly created service room (typically the human
     * who should receive the alerts on their phone).
     */
    inviteUserIds?: string[];

    /**
     * The Matrix `msgtype` used for forwarded alerts. Defaults to `m.notice`,
     * which keeps well-behaved clients from treating alerts as ordinary chat.
     */
    msgtype?: string;

    /**
     * Only forward messages whose ntfy priority is greater than or equal to this
     * value (1-5). Defaults to forwarding everything.
     */
    priorityThreshold?: number;

    /**
     * Cleanup configuration. Pass `false` to disable automatic cleanup. Defaults
     * to redacting alerts after 24 hours.
     */
    cleanup?: AlertCleanupOptions | false;

    /**
     * Overrides how an ntfy message is rendered into Matrix message content.
     */
    formatMessage?: (msg: NtfyMessage) => FormattedAlert;
}

const DEFAULT_CLEANUP: AlertCleanupOptions = {
    ttlMs: 24 * 60 * 60 * 1000,
    mode: "redact",
};

/**
 * Bridges ntfy.sh notifications into a hidden Matrix service room.
 *
 * The bridge subscribes to one or more ntfy topics, forwards every notification
 * into a dedicated room, and (optionally) runs an {@link AlertCleanupService}
 * that removes alerts once they age out so they don't pile up in the user's
 * history. The room is created as a private, non-published room and is tagged
 * with a marker state event so clients can hide it from the main room list.
 *
 * Pair this with the push rules described in the "ntfy alerts" tutorial to make
 * alerts ring through on mobile without inflating the user's unread counts.
 * @category Ntfy alerts
 */
export class NtfyMatrixBridge {
    private readonly subscribers: NtfyClient[] = [];
    private cleanupService?: AlertCleanupService;
    private roomId?: string;
    private started = false;

    /**
     * Creates a new bridge. Call {@link start} to create/resolve the room and
     * begin forwarding.
     * @param {MatrixClient} client The Matrix client used to post and manage alerts.
     * @param {NtfyMatrixBridgeOptions} options The bridge configuration.
     */
    public constructor(
        private readonly client: MatrixClient,
        private readonly options: NtfyMatrixBridgeOptions,
    ) {
        const ntfy = Array.isArray(options.ntfy) ? options.ntfy : [options.ntfy];
        for (const entry of ntfy) {
            this.subscribers.push(entry instanceof NtfyClient ? entry : new NtfyClient(entry));
        }
        if (!this.subscribers.length) {
            throw new Error("At least one ntfy subscription is required");
        }
    }

    /**
     * The ID of the room alerts are posted into. Only available after {@link start}.
     */
    public get serviceRoomId(): string | undefined {
        return this.roomId;
    }

    /**
     * The cleanup service, if cleanup is enabled. Only available after {@link start}.
     */
    public get cleanup(): AlertCleanupService | undefined {
        return this.cleanupService;
    }

    /**
     * Resolves (or creates) the hidden service room, wires up the ntfy
     * subscriptions, and starts cleanup. Calling start twice is a no-op.
     * @returns {Promise<string>} Resolves to the service room ID.
     */
    public async start(): Promise<string> {
        if (this.started) return this.roomId;
        this.started = true;

        this.roomId = await this.resolveRoom();

        if (this.options.cleanup !== false) {
            const cleanupOpts = this.options.cleanup ?? DEFAULT_CLEANUP;
            this.cleanupService = new AlertCleanupService(this.client, this.roomId, cleanupOpts);
            this.cleanupService.start();
        }

        for (const sub of this.subscribers) {
            sub.on("message", (msg: NtfyMessage) => {
                // noinspection JSIgnoredPromiseFromCall
                this.handleMessage(msg);
            });
            sub.on("error", (e) => LogService.warn("NtfyMatrixBridge", `ntfy subscription error on ${sub.topic}:`, e));
            sub.start();
        }

        LogService.info("NtfyMatrixBridge", `Forwarding ${this.subscribers.length} ntfy topic(s) into ${this.roomId}`);
        return this.roomId;
    }

    /**
     * Stops all subscriptions and cleanup. The service room is left intact.
     */
    public stop(): void {
        if (!this.started) return;
        this.started = false;
        for (const sub of this.subscribers) {
            sub.stop();
        }
        this.cleanupService?.stop();
    }

    /**
     * Formats and posts a single ntfy message into the service room, then tracks
     * it for cleanup. Exposed for testing and manual forwarding.
     * @param {NtfyMessage} msg The ntfy message to forward.
     * @returns {Promise<string | null>} The posted event ID, or null if the message was filtered out.
     */
    public async handleMessage(msg: NtfyMessage): Promise<string | null> {
        if (!this.roomId) throw new Error("The bridge has not been started");

        const priority = msg.priority ?? 3;
        if (this.options.priorityThreshold && priority < this.options.priorityThreshold) {
            return null;
        }

        const formatted = (this.options.formatMessage ?? defaultFormatMessage)(msg);
        const content: any = {
            msgtype: this.options.msgtype ?? "m.notice",
            body: formatted.body,
            [NTFY_ALERT_CONTENT_FLAG]: true,
            "world.ixo.ntfy.meta": {
                id: msg.id,
                topic: msg.topic,
                priority,
                tags: msg.tags ?? [],
                click: msg.click,
            },
        };
        if (formatted.formatted_body) {
            content.format = "org.matrix.custom.html";
            content.formatted_body = formatted.formatted_body;
        }

        let eventId: string;
        try {
            eventId = await this.client.sendMessage(this.roomId, content);
        } catch (e) {
            LogService.error("NtfyMatrixBridge", `Failed to forward ntfy alert ${msg.id}:`, extractRequestError(e));
            throw e;
        }

        if (this.cleanupService) {
            try {
                await this.cleanupService.track(eventId, Date.now(), msg.topic);
            } catch (e) {
                LogService.warn("NtfyMatrixBridge", `Failed to track alert ${eventId} for cleanup:`, extractRequestError(e));
            }
        }

        return eventId;
    }

    private async resolveRoom(): Promise<string> {
        if (this.options.roomId) {
            await this.rememberRoom(this.options.roomId);
            return this.options.roomId;
        }

        const stored = await this.client.getSafeAccountData<{ roomId?: string }>(NTFY_BRIDGE_EVENT_TYPE, {});
        if (stored?.roomId) {
            return stored.roomId;
        }

        if (this.options.createRoomIfMissing === false) {
            throw new Error("No ntfy service room configured and createRoomIfMissing is disabled");
        }

        const roomId = await this.createServiceRoom();
        await this.rememberRoom(roomId);
        return roomId;
    }

    private async createServiceRoom(): Promise<string> {
        const roomId = await this.client.createRoom({
            name: this.options.roomName ?? "System Alerts",
            topic: this.options.roomTopic ?? "Automated system alerts bridged from ntfy. Managed automatically.",
            preset: "private_chat",
            visibility: "private",
            invite: this.options.inviteUserIds ?? [],
            initial_state: [{
                type: NTFY_SERVICE_ROOM_MARKER,
                state_key: "",
                content: { managed: true, source: "ntfy" },
            }],
        });
        LogService.info("NtfyMatrixBridge", `Created hidden ntfy service room ${roomId}`);
        return roomId;
    }

    private async rememberRoom(roomId: string): Promise<void> {
        try {
            await this.client.setAccountData(NTFY_BRIDGE_EVENT_TYPE, { roomId });
        } catch (e) {
            LogService.warn("NtfyMatrixBridge", "Failed to persist ntfy service room ID:", extractRequestError(e));
        }
    }
}

/**
 * The default renderer for ntfy messages. Produces a compact alert with the
 * title, priority and tags surfaced, plus an optional click-through link.
 * @param {NtfyMessage} msg The ntfy message.
 * @returns {FormattedAlert} The plain text and HTML rendering.
 * @category Ntfy alerts
 */
export function defaultFormatMessage(msg: NtfyMessage): FormattedAlert {
    const title = msg.title?.trim();
    const body = msg.message?.trim() ?? "";
    const tags = (msg.tags ?? []).filter(t => !!t);

    const textParts: string[] = [];
    if (title) textParts.push(title);
    if (body) textParts.push(body);
    if (tags.length) textParts.push(`[${tags.join(", ")}]`);
    if (msg.click) textParts.push(msg.click);
    const text = textParts.join("\n");

    const htmlParts: string[] = [];
    if (title) htmlParts.push(`<strong>${escapeHtml(title)}</strong>`);
    if (body) htmlParts.push(escapeHtml(body));
    const footer: string[] = [];
    if (tags.length) footer.push(escapeHtml(`[${tags.join(", ")}]`));
    if (msg.click) footer.push(`<a href="${escapeHtml(msg.click)}">${escapeHtml(msg.click)}</a>`);
    if (footer.length) htmlParts.push(`<small>${footer.join(" ")}</small>`);

    return {
        body: text || "(empty alert)",
        formatted_body: htmlParts.length ? htmlParts.join("<br/>") : undefined,
    };
}

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
