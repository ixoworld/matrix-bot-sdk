import { MatrixClient } from "../MatrixClient";
import { EncryptionEventContent } from "../models/events/EncryptionEvent";
import { ICryptoRoomInformation } from "./ICryptoRoomInformation";
import { MatrixError } from "../models/MatrixError";
import { LogService } from "../logging/LogService";

/**
 * How many room state requests may be in flight at once during prepare().
 * Kept modest so a fleet of bots restarting together (eg after a homeserver
 * upgrade) does not stampede the server.
 */
const PREPARE_CONCURRENCY = 16;

// noinspection ES6RedundantAwait
/**
 * Tracks room encryption status for a MatrixClient.
 * @category Encryption
 */
export class RoomTracker {
    public constructor(private client: MatrixClient) {
    }

    /**
     * Handles a room join
     * @internal
     * @param roomId The room ID.
     */
    public async onRoomJoin(roomId: string) {
        // Force: the room's encryption state may have changed while we were
        // not a member, so any cached result (including "not encrypted") is
        // untrustworthy.
        await this.queueRoomCheck(roomId, true);
    }

    /**
     * Handles a room event.
     * @internal
     * @param roomId The room ID.
     * @param event The event.
     */
    public async onRoomEvent(roomId: string, event: any) {
        if (event['state_key'] !== '') return; // we don't care about anything else
        if (event['type'] === 'm.room.encryption' || event['type'] === 'm.room.history_visibility') {
            // Force: these events supersede whatever we have cached — a room
            // may have just enabled encryption (invalidating a "not encrypted"
            // marker), or changed the history visibility stored alongside an
            // encrypted room's config.
            await this.queueRoomCheck(roomId, true);
        }
    }

    /**
     * Prepares the room tracker to track the given rooms.
     *
     * Only rooms already known to be encrypted are skipped — encryption cannot
     * be disabled once enabled. Unencrypted rooms are deliberately not cached:
     * every consumer asks the server on use, so a room that enables encryption
     * at any point is always seen. This scan is therefore purely a cache
     * warm-up for encrypted rooms; correctness never depends on it running.
     * @param {string[]} roomIds The room IDs to track. This should be the joined rooms set.
     */
    public async prepare(roomIds: string[]) {
        const toCheck: string[] = [];
        for (const roomId of roomIds) {
            const config = await this.client.cryptoStore.getRoom(roomId);
            if (config?.algorithm !== undefined) continue;
            toCheck.push(roomId);
        }
        if (!toCheck.length) return;
        LogService.debug("RoomTracker", `Checking encryption state of ${toCheck.length} room(s)`);

        // Fetch with bounded concurrency and persist the results in a single
        // batch: the file-backed store rewrites its whole database on every
        // individual write, which is prohibitive when a fresh store meets an
        // account with thousands of encrypted rooms.
        const results: Record<string, ICryptoRoomInformation> = {};
        let cursor = 0;
        const worker = async () => {
            while (cursor < toCheck.length) {
                const roomId = toCheck[cursor++];
                try {
                    const config = await this.checkRoom(roomId);
                    if (config) results[roomId] = config;
                } catch (e) {
                    // Non-definitive failure (network, rate limiting, …): skip;
                    // the next use of the room asks the server again.
                    LogService.warn("RoomTracker", `Failed to check encryption state of ${roomId}`, e);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(PREPARE_CONCURRENCY, toCheck.length) }, () => worker()));

        const entries = Object.entries(results);
        if (!entries.length) return;
        if (this.client.cryptoStore.storeRooms) {
            await this.client.cryptoStore.storeRooms(results);
        } else {
            for (const [roomId, config] of entries) {
                await this.client.cryptoStore.storeRoom(roomId, config);
            }
        }
    }

    /**
     * Queues a room check for the tracker. If the room needs an update to the store, an
     * update will be made.
     * @param {string} roomId The room ID to check.
     * @param {boolean} force When true, any cached result is ignored and the room's
     * state is re-fetched from the server. Used when an event indicates the cached
     * result is stale (encryption enabled, history visibility changed, room joined).
     */
    public async queueRoomCheck(roomId: string, force = false) {
        if (!force) {
            const config = await this.client.cryptoStore.getRoom(roomId);
            if (config?.algorithm !== undefined) {
                return; // encryption cannot be disabled once enabled
            }
        }

        let result: ICryptoRoomInformation | null;
        try {
            result = await this.checkRoom(roomId);
        } catch (e) {
            // Non-definitive failure: record nothing; the next use of the room
            // asks the server again.
            LogService.warn("RoomTracker", `Failed to check encryption state of ${roomId}`, e);
            return;
        }

        if (result) {
            await this.client.cryptoStore.storeRoom(roomId, result);
        }
    }

    /**
     * Fetches a room's encryption configuration from the server.
     * @returns The encryption event content (plus history visibility) for
     * encrypted rooms, or null when the room definitively has no encryption
     * state event. "Not encrypted" is deliberately never cached: consumers ask
     * the server on use, so a room that enables encryption is always seen.
     * @throws When the server's answer is non-definitive (network error, rate
     * limiting, …) — callers must never treat that as "not encrypted".
     */
    private async checkRoom(roomId: string): Promise<ICryptoRoomInformation | null> {
        let encEvent: Partial<EncryptionEventContent>;
        try {
            encEvent = await this.client.getRoomStateEvent(roomId, "m.room.encryption", "");
            encEvent.algorithm = encEvent.algorithm ?? 'UNKNOWN';
        } catch (e) {
            if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") {
                return null; // definitive: the room has no encryption state event
            }
            throw e;
        }

        // Pick out the history visibility setting too
        let historyVisibility: string;
        try {
            const ev = await this.client.getRoomStateEvent(roomId, "m.room.history_visibility", "");
            historyVisibility = ev.history_visibility;
        } catch (e) {
            // ignore - we'll just treat history visibility as normal
        }

        return {
            ...encEvent,
            historyVisibility,
        };
    }

    /**
     * Gets the room's crypto configuration, as known by the underlying store. If the room is
     * not encrypted then this will return an empty object.
     * @param {string} roomId The room ID to get the config for.
     * @returns {Promise<ICryptoRoomInformation>} Resolves to the encryption config.
     */
    public async getRoomCryptoConfig(roomId: string, failClosed = false): Promise<ICryptoRoomInformation> {
        let config = await this.client.cryptoStore.getRoom(roomId);
        if (!config) {
            let result: ICryptoRoomInformation | null = null;
            try {
                result = await this.checkRoom(roomId);
            } catch (e) {
                LogService.warn("RoomTracker", `Failed to check encryption state of ${roomId}`, e);
                // Guessing "not encrypted" off a transient failure would let an
                // encrypted room's message go out as plaintext — callers
                // protecting a send path must fail instead.
                if (failClosed) throw e;
            }
            if (result) {
                await this.client.cryptoStore.storeRoom(roomId, result);
                config = result;
            }
        }
        return config ?? {};
    }
}
