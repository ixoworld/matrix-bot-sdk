import { MatrixClient } from "../MatrixClient";
import { Appservice } from "../appservice/Appservice";
import { extractRequestError, LogService } from "../logging/LogService";

const LOG_TAG = "AutojoinRoomsMixin";

const RETRY_BACKOFF_MS = [500, 1000, 2000];
const MAX_RETRIES = 3;
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_INITIAL_DELAY_MS = 90_000;
const SWEEP_SYNC_TIMEOUT_MS = 30_000;

const STORAGE_KEY_SWEEP_SYNC_TOKEN = "autojoin_sweep_sync_token";
const STORAGE_KEY_SWEEP_FILTER_ID = "autojoin_sweep_filter_id";

const SWEEP_INTERVAL_KEY = "__autojoinSweepInterval";
const SWEEP_INITIAL_TIMEOUT_KEY = "__autojoinSweepInitialTimeout";
const SWEEP_RUNNING_KEY = "__autojoinSweepRunning";
const INVITE_LISTENER_KEY = "__autojoinInviteListener";

const SWEEP_FILTER = {
    account_data: { types: [] },
    presence: { types: [] },
    room: {
        leave: {
            rooms: [],
        },
        join: {
            timeline: { types: [], limit: 0 },
            state: { types: [] },
            account_data: { types: [] },
            ephemeral: { types: [] },
        },
        invite: {
            state: {
                types: ["m.room.member"],
            },
        },
    },
};

/**
 * Automatically accepts invites for rooms with retry logic and periodic
 * sweep to catch missed invites.
 * @category Mixins
 */
export class AutojoinRoomsMixin {
    private static async joinRoomWithRetry(
        joinFn: () => Promise<string>,
        roomId: string,
        context: string,
    ): Promise<boolean> {
        const maxAttempts = MAX_RETRIES + 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await joinFn();
                LogService.info(LOG_TAG, `Joined room ${roomId} (${context})`);
                return true;
            } catch (err) {
                if (attempt === maxAttempts) {
                    LogService.error(
                        LOG_TAG,
                        `Failed to join room ${roomId} after ${maxAttempts} attempts (${context}):`,
                        extractRequestError(err),
                    );
                    return false;
                }
                const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? 2000;
                LogService.warn(
                    LOG_TAG,
                    `Failed to join room ${roomId} (${context}), attempt ${attempt}/${maxAttempts}. Retrying in ${backoff}ms:`,
                    extractRequestError(err),
                );
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
        return false;
    }

    private static async ensureSweepFilter(client: MatrixClient): Promise<string | null> {
        const existingFilterId = await Promise.resolve(
            client.storageProvider.readValue(STORAGE_KEY_SWEEP_FILTER_ID),
        );
        if (existingFilterId) {
            return existingFilterId;
        }

        try {
            const userId = await client.getUserId();
            const response = await client.doRequest(
                "POST",
                "/_matrix/client/v3/user/" + encodeURIComponent(userId) + "/filter",
                null,
                SWEEP_FILTER,
            );
            const filterId = String(response["filter_id"]);
            await Promise.resolve(
                client.storageProvider.storeValue(STORAGE_KEY_SWEEP_FILTER_ID, filterId),
            );
            LogService.info(LOG_TAG, `Created sweep filter: ${filterId}`);
            return filterId;
        } catch (err) {
            LogService.error(LOG_TAG, "Failed to create sweep filter:", extractRequestError(err));
            return null;
        }
    }

    private static async performSweep(client: MatrixClient): Promise<void> {
        if ((client as any)[SWEEP_RUNNING_KEY]) {
            LogService.debug(LOG_TAG, "Sweep already in progress, skipping");
            return;
        }
        (client as any)[SWEEP_RUNNING_KEY] = true;

        try {
            const filterId = await AutojoinRoomsMixin.ensureSweepFilter(client);
            if (!filterId) return;

            const token = await Promise.resolve(
                client.storageProvider.readValue(STORAGE_KEY_SWEEP_SYNC_TOKEN),
            );

            const qs: Record<string, any> = {
                timeout: 0,
                full_state: false,
                filter: filterId,
            };
            if (token) {
                qs.since = token;
            }

            const response = await client.doRequest("GET", "/_matrix/client/v3/sync", qs, null, SWEEP_SYNC_TIMEOUT_MS);

            const inviteRooms = response?.rooms?.invite;
            if (!inviteRooms || typeof inviteRooms !== "object") {
                const nextBatch = response?.next_batch;
                if (nextBatch) {
                    await Promise.resolve(
                        client.storageProvider.storeValue(STORAGE_KEY_SWEEP_SYNC_TOKEN, nextBatch),
                    );
                }
                return;
            }

            const userId = await client.getUserId();
            const roomIds = Object.keys(inviteRooms);

            if (roomIds.length > 0) {
                LogService.info(LOG_TAG, `Sweep found ${roomIds.length} pending invite(s)`);
            }

            let allJoined = true;
            for (const roomId of roomIds) {
                const room = inviteRooms[roomId];
                if (!room["invite_state"] || !room["invite_state"]["events"]) continue;

                let inviteEvent = null;
                for (const event of room["invite_state"]["events"]) {
                    if (event["type"] !== "m.room.member") continue;
                    if (event["state_key"] !== userId) continue;
                    if (!event["content"]) continue;
                    if (event["content"]["membership"] !== "invite") continue;

                    const oldAge = inviteEvent?.unsigned?.age ?? 0;
                    const newAge = event?.unsigned?.age ?? 0;
                    if (inviteEvent && oldAge < newAge) continue;

                    inviteEvent = event;
                }

                if (!inviteEvent) continue;

                const joined = await AutojoinRoomsMixin.joinRoomWithRetry(
                    () => client.joinRoom(roomId),
                    roomId,
                    "sweep",
                );
                if (!joined) allJoined = false;
            }

            const nextBatch = response?.next_batch;
            if (nextBatch && allJoined) {
                await Promise.resolve(
                    client.storageProvider.storeValue(STORAGE_KEY_SWEEP_SYNC_TOKEN, nextBatch),
                );
            } else if (nextBatch && !allJoined) {
                LogService.warn(LOG_TAG, "Sweep token not advanced due to failed join(s), will retry next sweep");
            }
        } catch (err) {
            LogService.error(LOG_TAG, "Sweep failed:", extractRequestError(err));
        } finally {
            (client as any)[SWEEP_RUNNING_KEY] = false;
        }
    }

    public static setupOnClient(client: MatrixClient): void {
        // Clean up any existing sweep timers to prevent leaks from duplicate setup
        AutojoinRoomsMixin.stopSweep(client);

        const inviteListener = (roomId: string, _inviteEvent: any) => {
            AutojoinRoomsMixin.joinRoomWithRetry(
                () => client.joinRoom(roomId),
                roomId,
                "invite-event",
            ).catch(err => {
                LogService.error(LOG_TAG, `Unexpected error in invite listener for ${roomId}:`, extractRequestError(err));
            });
        };
        client.on("room.invite", inviteListener);
        (client as any)[INVITE_LISTENER_KEY] = inviteListener;

        const interval = setInterval(() => {
            AutojoinRoomsMixin.performSweep(client);
        }, SWEEP_INTERVAL_MS);
        (client as any)[SWEEP_INTERVAL_KEY] = interval;

        const initialTimeout = setTimeout(() => {
            AutojoinRoomsMixin.performSweep(client);
        }, SWEEP_INITIAL_DELAY_MS);
        (client as any)[SWEEP_INITIAL_TIMEOUT_KEY] = initialTimeout;

        LogService.info(LOG_TAG, "Autojoin configured with retry and periodic sweep");
    }

    public static setupOnAppservice(appservice: Appservice, conditional: (inviteEvent: any) => boolean = null): void {
        appservice.on("room.invite", (roomId: string, inviteEvent: any) => {
            const isFromBot = appservice.botUserId === inviteEvent["sender"];
            if (!isFromBot && conditional && !conditional(inviteEvent)) return;

            const intent = appservice.getIntentForUserId(inviteEvent["state_key"]);
            AutojoinRoomsMixin.joinRoomWithRetry(
                () => intent.joinRoom(roomId),
                roomId,
                "appservice-invite",
            );
        });
    }

    /**
     * Stops the periodic invite sweep for the given client.
     */
    public static stopSweep(client: MatrixClient): void {
        const interval = (client as any)[SWEEP_INTERVAL_KEY];
        if (interval) {
            clearInterval(interval);
            delete (client as any)[SWEEP_INTERVAL_KEY];
        }
        const initialTimeout = (client as any)[SWEEP_INITIAL_TIMEOUT_KEY];
        if (initialTimeout) {
            clearTimeout(initialTimeout);
            delete (client as any)[SWEEP_INITIAL_TIMEOUT_KEY];
        }
        const listener = (client as any)[INVITE_LISTENER_KEY];
        if (listener) {
            client.removeListener("room.invite", listener);
            delete (client as any)[INVITE_LISTENER_KEY];
        }
        delete (client as any)[SWEEP_RUNNING_KEY];
    }
}
