import { EventEmitter } from "events";

import { LogService } from "../logging/LogService";
import { NtfyMessage } from "./INtfyMessage";

/**
 * Options for connecting to an ntfy topic.
 * @category Ntfy alerts
 */
export interface NtfyClientOptions {
    /**
     * The topic to subscribe to. Required.
     */
    topic: string;

    /**
     * The base URL of the ntfy server. Defaults to `https://ntfy.sh`.
     */
    baseUrl?: string;

    /**
     * A bearer/access token used to subscribe to protected topics. Takes
     * precedence over `username`/`password` when both are supplied.
     */
    token?: string;

    /**
     * The username to use for HTTP basic auth on protected topics.
     */
    username?: string;

    /**
     * The password to use for HTTP basic auth on protected topics.
     */
    password?: string;

    /**
     * The ntfy `since` parameter, used to replay messages the subscriber may
     * have missed while disconnected. Accepts a unix timestamp, a duration
     * such as `"10m"`, or a message ID. Defaults to `"all"` on first connect
     * and is automatically advanced to the last seen message afterwards.
     */
    since?: string | number;

    /**
     * Whether to automatically reconnect when the stream drops. Defaults to true.
     */
    reconnect?: boolean;

    /**
     * The minimum delay before reconnecting, in milliseconds. Defaults to 1000.
     */
    minReconnectMs?: number;

    /**
     * The maximum delay before reconnecting, in milliseconds. Defaults to 60000.
     */
    maxReconnectMs?: number;
}

/**
 * A streaming subscriber for an ntfy topic. The client connects to the ntfy
 * JSON stream endpoint and emits a `message` event for every notification.
 *
 * Emitted events:
 * - `message` - a {@link NtfyMessage} with `event: "message"` was received.
 * - `open` - the upstream stream connected (or reconnected).
 * - `close` - the stream was closed (intentionally or otherwise).
 * - `error` - an error occurred while connecting or reading the stream.
 *
 * The client never throws from {@link start}; transport failures are surfaced
 * via the `error` event and, when `reconnect` is enabled, retried with
 * exponential backoff.
 * @category Ntfy alerts
 */
export class NtfyClient extends EventEmitter {
    private readonly baseUrl: string;
    private readonly options: NtfyClientOptions;

    private controller?: AbortController;
    private running = false;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private currentBackoff: number;
    private since: string | number;

    /**
     * Creates a new ntfy subscriber. Call {@link start} to begin receiving messages.
     * @param {NtfyClientOptions} options The subscription options.
     */
    public constructor(options: NtfyClientOptions) {
        super();
        if (!options?.topic) {
            throw new Error("An ntfy topic is required");
        }
        this.options = options;
        this.baseUrl = (options.baseUrl ?? "https://ntfy.sh").replace(/\/+$/, "");
        this.since = options.since ?? "all";
        this.currentBackoff = options.minReconnectMs ?? 1000;
    }

    /**
     * Whether the subscriber is currently active.
     * @returns {boolean} True if {@link start} has been called and {@link stop} has not.
     */
    public get isRunning(): boolean {
        return this.running;
    }

    /**
     * The topic this client is subscribed to.
     */
    public get topic(): string {
        return this.options.topic;
    }

    /**
     * Starts the subscription. This resolves immediately - messages are
     * delivered asynchronously via the `message` event. Calling start while
     * already running is a no-op.
     */
    public start(): void {
        if (this.running) return;
        this.running = true;
        // noinspection JSIgnoredPromiseFromCall
        this.connect();
    }

    /**
     * Stops the subscription and aborts any in-flight request. No further
     * events (other than a final `close`) will be emitted.
     */
    public stop(): void {
        if (!this.running) return;
        this.running = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.controller?.abort();
        this.controller = undefined;
        this.emit("close");
    }

    private buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {};
        if (this.options.token) {
            headers["Authorization"] = `Bearer ${this.options.token}`;
        } else if (this.options.username || this.options.password) {
            const raw = `${this.options.username ?? ""}:${this.options.password ?? ""}`;
            headers["Authorization"] = `Basic ${Buffer.from(raw).toString("base64")}`;
        }
        return headers;
    }

    private buildUrl(): string {
        const topic = encodeURIComponent(this.options.topic);
        const since = encodeURIComponent(String(this.since));
        return `${this.baseUrl}/${topic}/json?since=${since}`;
    }

    private async connect(): Promise<void> {
        if (!this.running) return;

        this.controller = new AbortController();
        let response: Response;
        try {
            response = await fetch(this.buildUrl(), {
                method: "GET",
                headers: this.buildHeaders(),
                signal: this.controller.signal,
            });
        } catch (e) {
            if (this.running) {
                this.emit("error", e);
                this.scheduleReconnect();
            }
            return;
        }

        if (!response.ok || !response.body) {
            if (this.running) {
                this.emit("error", new Error(`ntfy responded with status ${response.status}`));
                this.scheduleReconnect();
            }
            return;
        }

        // We connected successfully, so reset the backoff for the next failure.
        this.currentBackoff = this.options.minReconnectMs ?? 1000;
        this.emit("open");

        try {
            await this.readStream(response.body);
        } catch (e) {
            if (this.running && (e as Error)?.name !== "AbortError") {
                this.emit("error", e);
            }
        }

        // The stream ended. If we're still meant to be running, reconnect.
        if (this.running) {
            this.scheduleReconnect();
        }
    }

    private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // ntfy emits newline-delimited JSON, one object per line.
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (line.length > 0) {
                    this.handleLine(line);
                }
            }
        }
    }

    private handleLine(line: string): void {
        let parsed: NtfyMessage;
        try {
            parsed = JSON.parse(line);
        } catch (e) {
            LogService.warn("NtfyClient", `Ignoring unparseable ntfy frame: ${line}`);
            return;
        }

        // Advance `since` so a reconnect resumes after the last frame we saw.
        if (parsed.id) {
            this.since = parsed.id;
        } else if (parsed.time) {
            this.since = parsed.time;
        }

        switch (parsed.event) {
            case "message":
                this.emit("message", parsed);
                break;
            case "open":
            case "keepalive":
            case "poll_request":
                // Control frames - nothing to forward.
                break;
            default:
                LogService.debug("NtfyClient", `Unknown ntfy event type: ${parsed.event}`);
                break;
        }
    }

    private scheduleReconnect(): void {
        if (!this.running) return;
        if (this.options.reconnect === false) {
            this.running = false;
            this.emit("close");
            return;
        }
        if (this.reconnectTimer) return;

        const delay = this.currentBackoff;
        LogService.debug("NtfyClient", `Reconnecting to ntfy topic ${this.options.topic} in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            // noinspection JSIgnoredPromiseFromCall
            this.connect();
        }, delay);

        const max = this.options.maxReconnectMs ?? 60000;
        this.currentBackoff = Math.min(this.currentBackoff * 2, max);
    }
}
