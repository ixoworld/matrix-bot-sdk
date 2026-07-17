import {
    CollectStrategy,
    DeviceId,
    OlmMachine,
    UserId,
    DeviceLists,
    RoomId,
    Attachment,
    EncryptedAttachment,
    SecretStorageItems,
    SecretStorageKey,
} from "@ixo/matrix-sdk-crypto-nodejs";

import { MatrixClient } from "../MatrixClient";
import { LogService } from "../logging/LogService";
import {
    IMegolmEncrypted,
    IOlmEncrypted,
    IToDeviceMessage,
    OTKAlgorithm,
    OTKCounts,
    Signatures,
} from "../models/Crypto";
import { requiresReady } from "./decorators";
import { RoomTracker } from "./RoomTracker";
import { EncryptedRoomEvent } from "../models/events/EncryptedRoomEvent";
import { RoomEvent } from "../models/events/RoomEvent";
import { EncryptedFile } from "../models/events/MessageEvent";
import { RustSdkCryptoStorageProvider } from "../storage/RustSdkCryptoStorageProvider";
import { RustEngine, SYNC_LOCK_NAME } from "./RustEngine";
import { MembershipEvent } from "../models/events/MembershipEvent";
import { BackupManager, KeyBackupInfo, BackupTrustInfo } from "./BackupManager";

/**
 * Delay before the one-off deferred room scan scheduled by prepare(). Kept
 * well clear of the startup path: the scan is purely a warm-up/safety-net,
 * correctness never depends on it.
 */
const ROOM_SCAN_DELAY_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Configuration options for the crypto client.
 */
export interface CryptoClientConfig {
    /**
     * Base64-encoded recovery key for key backup.
     * If provided, enables automatic key backup and recovery, and is also used
     * (as a passphrase) to protect the cross-signing identity in Secret
     * Storage so that the identity survives crypto store resets.
     */
    recoveryKey?: string;
}

/**
 * How long after accepting an invite we will still accept an MSC4268 room key
 * bundle for the room. Mirrors matrix-js-sdk's
 * MAX_INVITE_ACCEPTANCE_MS_FOR_KEY_BUNDLE.
 */
const MAX_INVITE_ACCEPTANCE_MS_FOR_KEY_BUNDLE = 24 * 60 * 60 * 1000; // 24 hours

const ROOM_KEY_BUNDLE_EVENT_TYPES = ["m.room_key_bundle", "io.element.msc4268.room_key_bundle"];

/**
 * Manages encryption for a MatrixClient. Get an instance from a MatrixClient directly
 * rather than creating one manually.
 * @category Encryption
 */
export class CryptoClient {
    private ready = false;
    private deviceId: string;
    private deviceEd25519: string;
    private deviceCurve25519: string;
    private roomTracker: RoomTracker;
    private engine: RustEngine;
    private backupManager: BackupManager | null = null;
    private config: CryptoClientConfig;
    private roomScanTimer: ReturnType<typeof setTimeout> = null;
    private roomScanDelayMs = ROOM_SCAN_DELAY_MS; // settable for tests

    public constructor(private client: MatrixClient, config?: CryptoClientConfig) {
        this.roomTracker = new RoomTracker(this.client);
        this.config = config || {};
    }

    private get storage(): RustSdkCryptoStorageProvider {
        return <RustSdkCryptoStorageProvider> this.client.cryptoStore;
    }

    /**
     * The device ID for the MatrixClient.
     */
    public get clientDeviceId(): string {
        return this.deviceId;
    }

    /**
     * The device's Ed25519 identity
     */
    public get clientDeviceEd25519(): string {
        return this.deviceEd25519;
    }

    /**
     * Whether or not the crypto client is ready to be used. If not ready, prepare() should be called.
     * @see prepare
     */
    public get isReady(): boolean {
        return this.ready;
    }

    /**
     * Prepares the crypto client for usage.
     * @param {string[]} roomIds The room IDs the MatrixClient is joined to.
     */
    public async prepare(roomIds: string[]) {
        // One-off deferred room scan, well clear of the startup path: warms the
        // store for encrypted rooms and picks up anything missed while offline.
        // Correctness never depends on it — any room without a stored config is
        // checked against the server on first use.
        if (!this.roomScanTimer) {
            this.roomScanTimer = setTimeout(async () => {
                try {
                    await this.roomTracker.prepare(await this.client.getJoinedRooms().catch(() => roomIds));
                } catch (e) {
                    LogService.warn("CryptoClient", "Deferred room scan failed:", e);
                }
            }, this.roomScanDelayMs);
            this.roomScanTimer.unref?.();
        }

        if (this.ready) return; // stop re-preparing here

        const storedDeviceId = await this.client.cryptoStore.getDeviceId();
        if (storedDeviceId) {
            this.deviceId = storedDeviceId;
        } else {
            const deviceId = (await this.client.getWhoAmI())['device_id'];
            if (!deviceId) {
                throw new Error("Encryption not possible: server not revealing device ID");
            }
            this.deviceId = deviceId;
            await this.client.cryptoStore.setDeviceId(this.deviceId);
        }

        LogService.info("CryptoClient", "Starting with device ID:", this.deviceId); // info so all bots know for debugging

        const machine = await OlmMachine.initialize(
            new UserId(await this.client.getUserId()),
            new DeviceId(this.deviceId),
            this.storage.storagePath, "",
            this.storage.storageType,
        );
        this.engine = new RustEngine(machine, this.client);
        await this.engine.run();

        const identity = this.engine.machine.identityKeys;
        this.deviceCurve25519 = identity.curve25519.toBase64();
        this.deviceEd25519 = identity.ed25519.toBase64();

        LogService.debug("CryptoClient", "Running with device Ed25519 identity:", this.deviceEd25519); // info so all bots know for debugging

        // Initialize key backup if recovery key is provided
        if (this.config.recoveryKey) {
            LogService.info("CryptoClient", "Initializing key backup with provided recovery key");
            this.backupManager = new BackupManager(
                this.engine.machine,
                this.client,
                this.config.recoveryKey,
                this.engine.lock,
            );
            this.engine.setBackupManager(this.backupManager);

            try {
                const result = await this.backupManager.checkKeyBackupAndEnable();
                if (result) {
                    LogService.info("CryptoClient", `Key backup enabled: version ${result.backupInfo.version}`);
                } else {
                    LogService.info("CryptoClient", "No usable key backup found on server");
                }
            } catch (e) {
                LogService.warn("CryptoClient", "Error enabling key backup:", e);
            }

            // After backup is enabled, check if this is a fresh crypto store
            // If so, bulk restore all keys from backup before syncing
            try {
                const counts = await this.backupManager.getRoomKeyCounts();
                if (counts.total === 0) {
                    LogService.info("CryptoClient", "Fresh crypto store detected, restoring keys from backup...");
                    const activeVersion = await this.backupManager.getActiveBackupVersion();
                    if (activeVersion) {
                        const restoreResult = await this.backupManager.restoreKeyBackup();
                        LogService.info("CryptoClient", `Bulk restore complete: imported ${restoreResult.imported}/${restoreResult.total} keys`);
                    } else {
                        LogService.debug("CryptoClient", "No active backup version, skipping bulk restore");
                    }
                } else {
                    LogService.debug("CryptoClient", `Crypto store has ${counts.total} keys, skipping bulk restore`);
                }
            } catch (e) {
                // Don't fail startup if bulk restore fails - on-demand fetch will still work
                LogService.warn("CryptoClient", "Failed to bulk restore keys from backup:", e);
            }
        }

        this.ready = true;
    }

    /**
     * Handles a room event.
     * @internal
     * @param roomId The room ID.
     * @param event The event.
     */
    public async onRoomEvent(roomId: string, event: any) {
        await this.roomTracker.onRoomEvent(roomId, event);
        if (typeof event['state_key'] !== 'string') return;
        if (event['type'] === 'm.room.member') {
            const membership = new MembershipEvent(event);
            if (membership.effectiveMembership !== 'join' && membership.effectiveMembership !== 'invite') return;
            await this.engine.addTrackedUsers([membership.membershipFor]);
        } else if (event['type'] === 'm.room.encryption') {
            const members = await this.client.getRoomMembers(roomId, null, ['join', 'invite']);
            await this.engine.addTrackedUsers(members.map(e => e.membershipFor));
        }
    }

    /**
     * Handles a room join.
     * @internal
     * @param roomId The room ID.
     */
    public async onRoomJoin(roomId: string) {
        await this.roomTracker.onRoomJoin(roomId);
        if (await this.isRoomEncrypted(roomId)) {
            const members = await this.client.getRoomMembers(roomId, null, ['join', 'invite']);
            await this.engine.addTrackedUsers(members.map(e => e.membershipFor));
        }
    }

    /**
     * Cancels the deferred room scan scheduled by prepare(). Call when
     * shutting the client down.
     */
    public cancelDeferredRoomScan() {
        if (this.roomScanTimer) {
            clearTimeout(this.roomScanTimer);
            this.roomScanTimer = null;
        }
    }

    /**
     * Checks if a room is encrypted.
     * @param {string} roomId The room ID to check.
     * @param {boolean} failClosed When true, a failure to determine the room's
     * encryption state throws instead of returning false. Use on paths where a
     * wrong "not encrypted" answer would leak plaintext into an encrypted room.
     * @returns {Promise<boolean>} Resolves to true if encrypted, false otherwise.
     */
    @requiresReady()
    public async isRoomEncrypted(roomId: string, failClosed = false): Promise<boolean> {
        const config = await this.roomTracker.getRoomCryptoConfig(roomId, failClosed);
        return !!config?.algorithm;
    }

    /**
     * Updates the client's sync-related data.
     * @param {Array.<IToDeviceMessage<IOlmEncrypted>>} toDeviceMessages The to-device messages received.
     * @param {OTKCounts} otkCounts The current OTK counts.
     * @param {OTKAlgorithm[]} unusedFallbackKeyAlgs The unused fallback key algorithms.
     * @param {string[]} changedDeviceLists The user IDs which had device list changes.
     * @param {string[]} leftDeviceLists The user IDs which the server believes we no longer need to track.
     * @returns {Promise<void>} Resolves when complete.
     */
    @requiresReady()
    public async updateSyncData(
        toDeviceMessages: IToDeviceMessage<IOlmEncrypted>[],
        otkCounts: OTKCounts,
        unusedFallbackKeyAlgs: OTKAlgorithm[],
        changedDeviceLists: string[],
        leftDeviceLists: string[],
    ): Promise<void> {
        const deviceMessages = JSON.stringify(toDeviceMessages);
        const deviceLists = new DeviceLists(
            changedDeviceLists.map(u => new UserId(u)),
            leftDeviceLists.map(u => new UserId(u)));

        const decryptedToDeviceMessages = await this.engine.lock.acquire(SYNC_LOCK_NAME, async () => {
            const syncResp = JSON.parse(await this.engine.machine.receiveSyncChanges(deviceMessages, deviceLists, otkCounts, unusedFallbackKeyAlgs));
            // The binding returns a tuple of [decryptedToDeviceMessages, roomKeyInfos]
            // since 0.5.x; older versions returned the messages array directly.
            const messages = Array.isArray(syncResp?.[0]) ? syncResp[0] : syncResp;
            if (Array.isArray(messages)) {
                for (const msg of messages) {
                    this.client.emit("to_device.decrypted", msg);
                }
            }

            await this.engine.run();

            // Trigger backup upload if new keys were received
            if (this.backupManager) {
                await this.backupManager.maybeUploadKey();
            }

            return Array.isArray(messages) ? messages : [];
        });

        // If we received a room key bundle message for a room we recently joined
        // from an invite, try to accept it. Runs outside the sync lock and
        // without blocking the sync loop (mirrors matrix-js-sdk).
        for (const msg of decryptedToDeviceMessages) {
            if (!msg || !ROOM_KEY_BUNDLE_EVENT_TYPES.includes(msg["type"]) || typeof msg["content"]?.["room_id"] !== "string") continue;
            const roomId = msg["content"]["room_id"];

            const pendingDetails = await this.engine.machine.getPendingKeyBundleDetailsForRoom(new RoomId(roomId));
            if (!pendingDetails) {
                LogService.debug("CryptoClient", `Not accepting key bundle for room where we are not awaiting a bundle: ${roomId}`);
            } else if (Date.now() - pendingDetails.inviteAcceptedAtMs > MAX_INVITE_ACCEPTANCE_MS_FOR_KEY_BUNDLE) {
                LogService.info("CryptoClient", `Ignoring key bundle for room we joined too long ago: ${roomId}`);
            } else {
                LogService.info("CryptoClient", `Considering key bundle for recently-joined room ${roomId}`);
                this.maybeAcceptKeyBundle(roomId, pendingDetails.inviter).catch(e => {
                    LogService.warn("CryptoClient", `Error accepting key bundle for room ${roomId}:`, e);
                });
            }
        }
    }

    /**
     * Signs an object using the device keys.
     * @param {object} obj The object to sign.
     * @returns {Promise<Signatures>} The signatures for the object.
     */
    @requiresReady()
    public async sign(obj: object): Promise<Signatures> {
        obj = JSON.parse(JSON.stringify(obj));
        const existingSignatures = obj['signatures'] || {};

        delete obj['signatures'];
        delete obj['unsigned'];

        const container = await this.engine.machine.sign(JSON.stringify(obj));
        const userSignature = container.get(new UserId(await this.client.getUserId()));
        const sig: Signatures = {
            [await this.client.getUserId()]: {},
        };
        for (const [key, maybeSignature] of Object.entries(userSignature)) {
            if (maybeSignature.isValid) {
                sig[await this.client.getUserId()][key] = maybeSignature.signature.toBase64();
            }
        }
        return {
            ...sig,
            ...existingSignatures,
        };
    }

    /**
     * Encrypts the details of a room event, returning an encrypted payload to be sent in an
     * `m.room.encrypted` event to the room. If needed, this function will send decryption keys
     * to the appropriate devices in the room (this happens when the Megolm session rotates or
     * gets created).
     * @param {string} roomId The room ID to encrypt within. If the room is not encrypted, an
     * error is thrown.
     * @param {string} eventType The event type being encrypted.
     * @param {any} content The event content being encrypted.
     * @returns {Promise<IMegolmEncrypted>} Resolves to the encrypted content for an `m.room.encrypted` event.
     */
    @requiresReady()
    public async encryptRoomEvent(roomId: string, eventType: string, content: any): Promise<IMegolmEncrypted> {
        if (!(await this.isRoomEncrypted(roomId))) {
            throw new Error("Room is not encrypted");
        }

        await this.engine.prepareEncrypt(roomId, await this.roomTracker.getRoomCryptoConfig(roomId));

        return await this.engine.lock.acquire(SYNC_LOCK_NAME, async () => {
            const encrypted = JSON.parse(await this.engine.machine.encryptRoomEvent(new RoomId(roomId), eventType, JSON.stringify(content)));
            await this.engine.run();
            return encrypted as IMegolmEncrypted;
        });
    }

    /**
     * Decrypts a room event. Currently only supports Megolm-encrypted events (default for this SDK).
     *
     * If decryption fails due to a missing key and key backup is enabled, this method will
     * automatically attempt to fetch the missing key from the backup and retry decryption.
     *
     * @param {EncryptedRoomEvent} event The encrypted event.
     * @param {string} roomId The room ID where the event was sent.
     * @returns {Promise<RoomEvent<unknown>>} Resolves to a decrypted room event, or rejects/throws with
     * an error if the event is undecryptable.
     */
    @requiresReady()
    public async decryptRoomEvent(event: EncryptedRoomEvent, roomId: string): Promise<RoomEvent<unknown>> {
        try {
            return await this.doDecryptRoomEvent(event, roomId);
        } catch (e: any) {
            // Check if this is a missing key error and we have backup enabled
            const errorMessage = e?.message || String(e);
            LogService.debug("CryptoClient", `Decryption error: "${errorMessage}"`);

            const isMissingKeyError = errorMessage.includes("MegolmDecryptionError") ||
                                       errorMessage.includes("UnknownMessageIndex") ||
                                       errorMessage.includes("missing key") ||
                                       errorMessage.includes("Unable to decrypt") ||
                                       errorMessage.includes("Can't find the room key");

            if (isMissingKeyError && this.backupManager) {
                const sessionId = event.megolmProperties?.session_id;
                if (sessionId) {
                    LogService.info("CryptoClient", `Decryption failed for session ${sessionId}, attempting key recovery from backup`);

                    try {
                        const imported = await this.backupManager.importSessionKeyFromBackup(roomId, sessionId);
                        if (imported) {
                            LogService.info("CryptoClient", `Successfully recovered key for session ${sessionId}, retrying decryption`);
                            return await this.doDecryptRoomEvent(event, roomId);
                        }
                    } catch (backupError) {
                        LogService.warn("CryptoClient", `Failed to recover key from backup for session ${sessionId}:`, backupError);
                    }
                }
            }

            // Re-throw the original error if backup recovery didn't help
            throw e;
        }
    }

    /**
     * Internal method to perform the actual decryption.
     */
    private async doDecryptRoomEvent(event: EncryptedRoomEvent, roomId: string): Promise<RoomEvent<unknown>> {
        const decrypted = await this.engine.machine.decryptRoomEvent(JSON.stringify(event.raw), new RoomId(roomId));
        const clearEvent = JSON.parse(decrypted.event);

        return new RoomEvent<unknown>({
            ...event.raw,
            type: clearEvent.type || "io.t2bot.unknown",
            content: (typeof (clearEvent.content) === 'object') ? clearEvent.content : {},
        });
    }

    /**
     * Encrypts a file for uploading in a room, returning the encrypted data and information
     * to include in a message event (except media URL) for sending.
     * @param {Buffer} file The file to encrypt.
     * @returns {{buffer: Buffer, file: Omit<EncryptedFile, "url">}} Resolves to the encrypted
     * contents and file information.
     */
    @requiresReady()
    public async encryptMedia(file: Buffer): Promise<{ buffer: Buffer, file: Omit<EncryptedFile, "url"> }> {
        const encrypted = Attachment.encrypt(file);
        const info = JSON.parse(encrypted.mediaEncryptionInfo);
        return {
            buffer: Buffer.from(encrypted.encryptedData),
            file: info,
        };
    }

    /**
     * Decrypts a previously-uploaded encrypted file, validating the fields along the way.
     * @param {EncryptedFile} file The file to decrypt.
     * @returns {Promise<Buffer>} Resolves to the decrypted file contents.
     */
    @requiresReady()
    public async decryptMedia(file: EncryptedFile): Promise<Buffer> {
        const contents = (await this.client.downloadContent(file.url)).data;
        const encrypted = new EncryptedAttachment(
            contents,
            JSON.stringify(file),
        );
        const decrypted = Attachment.decrypt(encrypted);
        return Buffer.from(decrypted);
    }

    /**
     * Ensures the client's user has a cross-signing identity published, restoring
     * it from Secret Storage when possible and bootstrapping a new one otherwise.
     * Sharing room history (MSC4268) requires this: key bundles are only ever
     * distributed identity-based, and the crypto layer refuses to send them when
     * our own cross-signing is not set up.
     *
     * When a recovery key is configured, the cross-signing private keys are kept
     * in Secret Storage (encrypted with a key derived from the recovery key), so
     * that a crypto store reset restores the SAME identity instead of minting a
     * new one — recipients would otherwise see the bot's identity change.
     *
     * The initial upload of cross-signing keys requires no user-interactive auth
     * when the account has no existing keys (MSC3967), so this works for bots and
     * appservice users.
     */
    @requiresReady()
    public async ensureCrossSigningBootstrapped(): Promise<void> {
        const status = await this.engine.machine.crossSigningStatus();
        if (status.hasMaster && status.hasSelfSigning && status.hasUserSigning) {
            // Self-heal partially-completed bootstraps: the private keys are in
            // the store, but the device signature upload or the Secret Storage
            // persist may not have happened.
            await this.ensureOwnDeviceCrossSigned();
            if (this.config.recoveryKey) {
                try {
                    await this.ensureCrossSigningPersisted();
                } catch (e) {
                    LogService.warn("CryptoClient", "Failed to persist cross-signing identity to Secret Storage:", e);
                }
            }
            return;
        }

        // Try to restore an existing identity from Secret Storage first.
        if (this.config.recoveryKey) {
            try {
                if (await this.tryRestoreCrossSigningFromSecretStorage()) {
                    LogService.info("CryptoClient", "Restored cross-signing identity from Secret Storage");
                    return;
                }
            } catch (e) {
                LogService.warn("CryptoClient", "Failed to restore cross-signing from Secret Storage; bootstrapping fresh identity:", e);
            }
        }

        LogService.info("CryptoClient", "Bootstrapping cross-signing for", await this.client.getUserId());
        const requests = await this.engine.machine.bootstrapCrossSigning(false);
        await this.engine.processCrossSigningBootstrapRequests(requests);

        // Persist the new identity to Secret Storage so it survives store resets.
        if (this.config.recoveryKey) {
            try {
                await this.persistCrossSigningToSecretStorage();
                LogService.info("CryptoClient", "Stored cross-signing identity in Secret Storage");
            } catch (e) {
                LogService.warn("CryptoClient", "Failed to store cross-signing identity in Secret Storage:", e);
            }
        }
    }

    /**
     * Make sure our own device carries a signature from our self-signing key,
     * signing and uploading one if needed. Recipients only trust key bundles
     * (and other identity-bound messages) from cross-signed devices.
     */
    private async ensureOwnDeviceCrossSigned(): Promise<void> {
        const userId = await this.client.getUserId();
        const device = await this.engine.machine.getDevice(new UserId(userId), new DeviceId(this.deviceId), undefined);
        if (!device || device.isCrossSignedByOwner()) return;

        LogService.info("CryptoClient", "Uploading cross-signing signature for own device");
        const request = await device.verify();
        await this.engine.uploadSignatures(request);
    }

    /**
     * Make sure the cross-signing private keys are stored in Secret Storage,
     * exporting them if they are not there yet.
     */
    private async ensureCrossSigningPersisted(): Promise<void> {
        try {
            await this.client.getAccountData("m.cross_signing.master");
            return; // already persisted
        } catch (e) {
            // fall through to persist
        }
        await this.persistCrossSigningToSecretStorage();
        LogService.info("CryptoClient", "Stored cross-signing identity in Secret Storage");
    }

    /**
     * Fetch the default Secret Storage key described in account data, unlocked
     * with the configured recovery key. Returns null when no key is set up.
     */
    private async getSecretStorageKey(): Promise<SecretStorageKey | null> {
        let defaultKey: { key?: string };
        try {
            defaultKey = await this.client.getAccountData<{ key?: string }>("m.secret_storage.default_key");
        } catch (e) {
            return null;
        }
        if (!defaultKey?.key) return null;

        const eventType = `m.secret_storage.key.${defaultKey.key}`;
        let keyContent: unknown;
        try {
            keyContent = await this.client.getAccountData(eventType);
        } catch (e) {
            return null;
        }

        return SecretStorageKey.fromAccountData(this.config.recoveryKey, eventType, JSON.stringify(keyContent));
    }

    /**
     * Fetch the default Secret Storage key, creating (and publishing) one derived
     * from the recovery key if none exists yet.
     */
    private async getOrCreateSecretStorageKey(): Promise<SecretStorageKey> {
        const existing = await this.getSecretStorageKey();
        if (existing) return existing;

        const key = SecretStorageKey.createFromPassphrase(this.config.recoveryKey);
        await this.client.setAccountData(`m.secret_storage.key.${key.keyId()}`, JSON.parse(key.accountDataContent()));
        await this.client.setAccountData("m.secret_storage.default_key", { key: key.keyId() });
        return key;
    }

    /**
     * Attempt to import the cross-signing private keys from Secret Storage.
     * Importing also self-signs this device; the resultant signature is uploaded.
     * @returns True when the identity was restored.
     */
    private async tryRestoreCrossSigningFromSecretStorage(): Promise<boolean> {
        const key = await this.getSecretStorageKey();
        if (!key) return false;

        const secrets: Record<string, string> = {};
        for (const [name, type] of [
            ["masterKey", "m.cross_signing.master"],
            ["userSigningKey", "m.cross_signing.user_signing"],
            ["selfSigningKey", "m.cross_signing.self_signing"],
        ]) {
            try {
                secrets[name] = JSON.stringify(await this.client.getAccountData(type));
            } catch (e) {
                LogService.debug("CryptoClient", `Secret ${type} not found in account data`);
                return false;
            }
        }

        // The machine must know our own PUBLIC cross-signing keys before it can
        // import the private ones (this device may have a fresh store).
        await this.engine.forceKeysQueryForUsers([await this.client.getUserId()]);

        const signatureRequest = await this.engine.machine.importSecretsFromSecretStorage(key, new SecretStorageItems(secrets));
        await this.engine.uploadSignatures(signatureRequest);
        return true;
    }

    /**
     * Encrypt the cross-signing private keys with the Secret Storage key and
     * publish them to account data.
     */
    private async persistCrossSigningToSecretStorage(): Promise<void> {
        const key = await this.getOrCreateSecretStorageKey();
        const items = await this.engine.machine.exportSecretsForSecretStorage(key);
        await this.client.setAccountData("m.cross_signing.master", JSON.parse(items.masterKey));
        await this.client.setAccountData("m.cross_signing.user_signing", JSON.parse(items.userSigningKey));
        await this.client.setAccountData("m.cross_signing.self_signing", JSON.parse(items.selfSigningKey));
    }

    /**
     * Record that we have accepted an invite for the given room, so that an
     * MSC4268 room key bundle arriving from the inviter soon should be accepted.
     * @param {string} roomId The room we were invited to.
     * @param {string} inviter The user who invited us.
     */
    @requiresReady()
    public async markRoomAsPendingKeyBundle(roomId: string, inviter: string): Promise<void> {
        await this.engine.machine.storeRoomPendingKeyBundle(new RoomId(roomId), new UserId(inviter));
    }

    /**
     * Having accepted an invite for the given room from the given user, attempt
     * to find information about a room key bundle and, if found, download the
     * bundle and import the room keys, as per
     * [MSC4268](https://github.com/matrix-org/matrix-spec-proposals/pull/4268).
     *
     * The bundle is only imported when the crypto layer can attribute it to the
     * inviter with sufficient trust (the sending device must be cross-signed by
     * the inviter).
     * @param {string} roomId The room we were invited to.
     * @param {string} inviter The user who invited us and is expected to have sent the bundle.
     * @returns {Promise<boolean>} True if a bundle was found, downloaded and imported.
     */
    @requiresReady()
    public async maybeAcceptKeyBundle(roomId: string, inviter: string): Promise<boolean> {
        // Make sure we have an up-to-date idea of the inviter's cross-signing keys,
        // so that we can check the device that sent us the bundle was cross-signed.
        await this.engine.forceKeysQueryForUsers([inviter]);

        const bundleData = await this.engine.machine.getReceivedRoomKeyBundleData(new RoomId(roomId), new UserId(inviter));
        if (!bundleData) {
            LogService.debug("CryptoClient", `No key bundle found for room ${roomId} from ${inviter}`);
            return false;
        }

        LogService.info("CryptoClient", `Fetching key bundle ${bundleData.url} for room ${roomId}`);
        const encryptedBundle = (await this.client.downloadContent(bundleData.url)).data;

        try {
            await this.engine.machine.receiveRoomKeyBundle(bundleData, new Uint8Array(encryptedBundle));
        } finally {
            // Even if the import failed, stop waiting for a bundle: the only
            // reason it can fail is a malformed bundle, so retrying won't help.
            await this.engine.machine.clearRoomPendingKeyBundle(new RoomId(roomId));
        }
        return true;
    }

    /**
     * Shares any shareable encrypted room history with the given user, as per
     * [MSC4268](https://github.com/matrix-org/matrix-spec-proposals/pull/4268).
     * Call this immediately before inviting the user to the room, so that the
     * key bundle is waiting for them when they accept.
     *
     * No-ops when the room is unencrypted, when its *current* history visibility
     * does not permit sharing (`joined`/`invited`), or when there are no
     * shareable keys. Note that only megolm sessions flagged with
     * `shared_history` (created by clients with MSC4268 support while the room
     * visibility allowed it) are included; the recipient's devices must be
     * cross-signed by the recipient to receive the bundle.
     * @param {string} roomId The room to share history for.
     * @param {string} userId The user to share history with.
     */
    @requiresReady()
    public async shareRoomHistoryWithUser(roomId: string, userId: string): Promise<void> {
        if (!(await this.isRoomEncrypted(roomId))) return;

        // Only share history if the *current* visibility allows it. Per the
        // spec, rooms without a history visibility event default to "shared".
        let historyVisibility = "shared";
        try {
            const ev = await this.client.getRoomStateEvent(roomId, "m.room.history_visibility", "");
            historyVisibility = ev?.["history_visibility"] ?? "shared";
        } catch (e) {
            // Missing event: fall through with the "shared" default.
        }
        if (historyVisibility === "joined" || historyVisibility === "invited") {
            LogService.debug("CryptoClient", `Not sharing history for ${roomId}: history visibility is ${historyVisibility}`);
            return;
        }

        await this.ensureCrossSigningBootstrapped();

        // Pull any keys we're missing from backup first, so the bundle covers
        // messages sent while this device was offline.
        if (this.backupManager && !(await this.engine.machine.hasDownloadedAllRoomKeys(new RoomId(roomId)))) {
            try {
                await this.backupManager.importRoomKeysFromBackup(roomId);
                await this.engine.machine.setHasDownloadedAllRoomKeys(new RoomId(roomId));
            } catch (e) {
                LogService.warn("CryptoClient", `Failed to restore backup keys for ${roomId} before sharing history:`, e);
            }
        }

        const bundle = await this.engine.machine.buildRoomKeyBundle(new RoomId(roomId));
        if (!bundle) {
            LogService.debug("CryptoClient", `No shareable keys in ${roomId}; not sending a key bundle`);
            return;
        }

        const mxcUri = await this.client.uploadContent(Buffer.from(bundle.encryptedData), "application/octet-stream");

        await this.engine.ensureSessionsForUsers([userId]);

        const requests = await this.engine.machine.shareRoomKeyBundleData(
            new UserId(userId),
            new RoomId(roomId),
            mxcUri,
            bundle.mediaEncryptionInfo,
            CollectStrategy.IdentityBasedStrategy,
        );
        await this.engine.sendToDeviceRequests(requests);

        LogService.info("CryptoClient", `Shared room history bundle for ${roomId} with ${userId} (${requests.length} to-device request(s))`);
    }

    // ==================== Key Backup Methods ====================

    /**
     * Check if key backup is enabled.
     * @returns True if key backup is enabled and active.
     */
    @requiresReady()
    public async isKeyBackupEnabled(): Promise<boolean> {
        if (!this.backupManager) return false;
        return await this.backupManager.isBackupEnabled();
    }

    /**
     * Get the current backup version info from the server.
     * @returns The backup info or null if no backup exists.
     */
    @requiresReady()
    public async getKeyBackupInfo(): Promise<KeyBackupInfo | null> {
        if (!this.backupManager) return null;
        return await this.backupManager.requestKeyBackupVersion();
    }

    /**
     * Get the currently active backup version.
     * @returns The backup version string or null if backup is not active.
     */
    @requiresReady()
    public async getActiveBackupVersion(): Promise<string | null> {
        if (!this.backupManager) return null;
        return await this.backupManager.getActiveBackupVersion();
    }

    /**
     * Get the current room key backup progress.
     * @returns The total and backed up key counts.
     */
    @requiresReady()
    public async getKeyBackupProgress(): Promise<{ total: number; backedUp: number } | null> {
        if (!this.backupManager) return null;
        return await this.backupManager.getRoomKeyCounts();
    }

    /**
     * Manually trigger a check for key backup on the server and enable if trusted.
     * This is automatically called during prepare() if a recovery key is configured.
     * @returns The backup info and trust status, or null if no usable backup.
     */
    @requiresReady()
    public async checkKeyBackupAndEnable(): Promise<{ backupInfo: KeyBackupInfo; trustInfo: BackupTrustInfo } | null> {
        if (!this.backupManager) {
            throw new Error("Key backup not configured - provide recoveryKey in CryptoClientConfig");
        }
        return await this.backupManager.checkKeyBackupAndEnable();
    }

    /**
     * Get the backup manager instance for advanced operations.
     * @returns The BackupManager or null if not configured.
     */
    public getBackupManager(): BackupManager | null {
        return this.backupManager;
    }
}
