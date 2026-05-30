import { MatrixClient } from "../MatrixClient";
import { LogService, extractRequestError } from "../logging/LogService";

/**
 * The room account data event type under which the cleanup ledger is stored.
 * The ledger records the alert events the bridge has posted so they can be
 * redacted or archived once they age out, without having to paginate room
 * history.
 * @category Ntfy alerts
 */
export const ALERT_LEDGER_EVENT_TYPE = "world.ixo.ntfy.alert_ledger";

/**
 * How expired alerts are disposed of.
 *
 * - `redact` removes the alert from the room entirely using a redaction.
 * - `archive` copies the alert into an archive room before redacting it from
 *   the live room, preserving a record while keeping the user's history clean.
 * @category Ntfy alerts
 */
export type AlertCleanupMode = "redact" | "archive";

/**
 * A single tracked alert awaiting cleanup.
 * @category Ntfy alerts
 */
export interface TrackedAlert {
    /**
     * The event ID of the posted alert.
     */
    eventId: string;

    /**
     * The time the alert was posted, in unix milliseconds.
     */
    ts: number;

    /**
     * The ntfy topic the alert originated from, for diagnostics.
     */
    topic?: string;
}

/**
 * The shape of the cleanup ledger persisted in room account data.
 * @category Ntfy alerts
 */
export interface AlertLedger {
    alerts: TrackedAlert[];
}

/**
 * Options for the {@link AlertCleanupService}.
 * @category Ntfy alerts
 */
export interface AlertCleanupOptions {
    /**
     * How long an alert may live before it is cleaned up, in milliseconds.
     */
    ttlMs: number;

    /**
     * How expired alerts are disposed of. Defaults to `redact`.
     */
    mode?: AlertCleanupMode;

    /**
     * The room to copy alerts into before redaction when `mode` is `archive`.
     * Required for archive mode; ignored otherwise.
     */
    archiveRoomId?: string;

    /**
     * How often the service sweeps for expired alerts, in milliseconds. Defaults
     * to a quarter of `ttlMs`, clamped between 1 minute and 1 hour.
     */
    intervalMs?: number;

    /**
     * The reason recorded on the redaction events. Defaults to a generic message.
     */
    redactionReason?: string;
}

/**
 * Periodically removes alert messages from a Matrix room once they exceed a
 * configured lifetime. The service keeps a small ledger of posted alerts in the
 * room's account data, so it can clean up reliably across restarts and without
 * scanning room history.
 *
 * The service is bound to a single room (typically the hidden service room used
 * by {@link NtfyMatrixBridge}). Register alerts with {@link track} as they are
 * posted, then call {@link start} to begin sweeping.
 * @category Ntfy alerts
 */
export class AlertCleanupService {
    private timer?: ReturnType<typeof setInterval>;
    private sweeping = false;
    private readonly mode: AlertCleanupMode;
    private readonly intervalMs: number;
    private readonly redactionReason: string;

    /**
     * Creates a new cleanup service.
     * @param {MatrixClient} client The client used to read account data and redact events.
     * @param {string} roomId The room whose alerts should be cleaned up.
     * @param {AlertCleanupOptions} options The cleanup options.
     */
    public constructor(
        private readonly client: MatrixClient,
        private readonly roomId: string,
        private readonly options: AlertCleanupOptions,
    ) {
        if (!options || !Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
            throw new Error("A positive ttlMs is required for alert cleanup");
        }
        this.mode = options.mode ?? "redact";
        if (this.mode === "archive" && !options.archiveRoomId) {
            throw new Error("archiveRoomId is required when cleanup mode is 'archive'");
        }
        this.redactionReason = options.redactionReason ?? "ntfy alert expired";

        const quarter = Math.floor(options.ttlMs / 4);
        const defaultInterval = Math.min(Math.max(quarter, 60000), 3600000);
        this.intervalMs = options.intervalMs ?? defaultInterval;
    }

    /**
     * Records an alert so it will be cleaned up once it expires. The ledger is
     * persisted to the room's account data.
     * @param {string} eventId The event ID of the posted alert.
     * @param {number} ts The time the alert was posted, in unix milliseconds. Defaults to now.
     * @param {string} topic The originating ntfy topic, for diagnostics.
     * @returns {Promise<void>} Resolves once the ledger has been persisted.
     */
    public async track(eventId: string, ts: number = Date.now(), topic?: string): Promise<void> {
        const ledger = await this.readLedger();
        ledger.alerts.push({ eventId, ts, topic });
        await this.writeLedger(ledger);
    }

    /**
     * Starts periodic cleanup. An initial sweep runs immediately. Calling start
     * while already running is a no-op.
     */
    public start(): void {
        if (this.timer) return;
        // noinspection JSIgnoredPromiseFromCall
        this.sweep();
        this.timer = setInterval(() => {
            // noinspection JSIgnoredPromiseFromCall
            this.sweep();
        }, this.intervalMs);
        // Don't keep the process alive solely for cleanup sweeps.
        this.timer.unref?.();
    }

    /**
     * Stops periodic cleanup. In-flight sweeps are allowed to complete.
     */
    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /**
     * Runs a single cleanup pass: every tracked alert older than `ttlMs` is
     * archived (if configured) and redacted, then removed from the ledger.
     * Alerts that have already disappeared are quietly dropped from the ledger.
     * Concurrent sweeps are coalesced into one.
     * @returns {Promise<number>} The number of alerts cleaned up during this pass.
     */
    public async sweep(): Promise<number> {
        if (this.sweeping) return 0;
        this.sweeping = true;
        try {
            const ledger = await this.readLedger();
            if (!ledger.alerts.length) return 0;

            const cutoff = Date.now() - this.options.ttlMs;
            const expired = ledger.alerts.filter(a => a.ts <= cutoff);
            if (!expired.length) return 0;

            const survivors: TrackedAlert[] = ledger.alerts.filter(a => a.ts > cutoff);
            let cleaned = 0;

            for (const alert of expired) {
                try {
                    await this.disposeOf(alert);
                    cleaned++;
                } catch (e) {
                    // Keep unresolved alerts in the ledger so we retry next sweep.
                    LogService.warn("AlertCleanupService", `Failed to clean up ${alert.eventId}:`, extractRequestError(e));
                    survivors.push(alert);
                }
            }

            await this.writeLedger({ alerts: survivors });
            if (cleaned > 0) {
                LogService.debug("AlertCleanupService", `Cleaned up ${cleaned} expired alert(s) in ${this.roomId}`);
            }
            return cleaned;
        } finally {
            this.sweeping = false;
        }
    }

    private async disposeOf(alert: TrackedAlert): Promise<void> {
        if (this.mode === "archive") {
            await this.archive(alert);
        }
        try {
            await this.client.redactEvent(this.roomId, alert.eventId, this.redactionReason);
        } catch (e) {
            // A 404 means the event is already gone - treat that as success.
            if (e?.body?.errcode === "M_NOT_FOUND" || e?.statusCode === 404) {
                return;
            }
            throw e;
        }
    }

    private async archive(alert: TrackedAlert): Promise<void> {
        let original: any;
        try {
            original = await this.client.getEvent(this.roomId, alert.eventId);
        } catch (e) {
            // If the source event is already gone there is nothing to archive.
            if (e?.body?.errcode === "M_NOT_FOUND" || e?.statusCode === 404) {
                return;
            }
            throw e;
        }

        const content = { ...(original?.content ?? {}) };
        content["world.ixo.ntfy.archived"] = {
            original_event_id: alert.eventId,
            original_room_id: this.roomId,
            archived_at: Date.now(),
            topic: alert.topic,
        };
        await this.client.sendMessage(this.options.archiveRoomId, content);
    }

    private async readLedger(): Promise<AlertLedger> {
        const ledger = await this.client.getSafeRoomAccountData<AlertLedger>(
            ALERT_LEDGER_EVENT_TYPE, this.roomId, { alerts: [] },
        );
        if (!ledger || !Array.isArray(ledger.alerts)) return { alerts: [] };
        return ledger;
    }

    private async writeLedger(ledger: AlertLedger): Promise<void> {
        await this.client.setRoomAccountData(ALERT_LEDGER_EVENT_TYPE, this.roomId, ledger);
    }
}
