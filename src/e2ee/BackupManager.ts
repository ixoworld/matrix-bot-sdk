import {
    BackupDecryptionKey,
    KeysBackupRequest,
    OlmMachine,
    RequestType,
    RoomKeyImportResult,
} from "@ixo/matrix-sdk-crypto-nodejs";
import bs58 from "bs58";

import { MatrixClient } from "../MatrixClient";
import { LogService } from "../logging/LogService";

// Constants for Base58 recovery key decoding
const OLM_RECOVERY_KEY_PREFIX = [0x8b, 0x01];
const KEY_SIZE = 32;

/**
 * Structure of an exported room key that can be imported into the OlmMachine.
 */
export interface ExportedRoomKey {
    algorithm: string;
    room_id: string;
    sender_key: string;
    session_id: string;
    session_key: string;
    sender_claimed_keys: Record<string, string>;
    forwarding_curve25519_key_chain: string[];
}

/**
 * Information about a key backup version from the server.
 */
export interface KeyBackupInfo {
    algorithm: string;
    auth_data: {
        public_key: string;
        signatures?: Record<string, Record<string, string>>;
    };
    version: string;
    count?: number;
    etag?: string;
}

/**
 * Trust information for a key backup.
 */
export interface BackupTrustInfo {
    /** Whether we have a matching decryption key stored */
    matchesDecryptionKey: boolean;
    /** Whether the backup is signed by a trusted key */
    trusted: boolean;
}

/**
 * Result of a key backup restore operation.
 */
export interface KeyBackupRestoreResult {
    total: number;
    imported: number;
}

/**
 * Session data structure in a key backup.
 */
export interface KeyBackupSessionData {
    first_message_index: number;
    forwarded_count: number;
    is_verified: boolean;
    session_data: {
        ephemeral: string;
        ciphertext: string;
        mac: string;
    };
}

/**
 * Manages key backup operations for the Matrix crypto client.
 *
 * This class handles:
 * - Checking and enabling server-side key backup
 * - Continuous background upload of room keys to the backup
 * - Key recovery from backup (with limitations - see restoreKeyBackup)
 *
 * @category Encryption
 */
export class BackupManager {
    private activeBackupVersion: string | null = null;
    private backupLoopRunning = false;
    private stopped = false;
    private decryptionKey: BackupDecryptionKey | null = null;
    private readonly recoveryKeyBase64?: string;
    /** In Memory Cache of session IDs confirmed missing from backup — avoids repeated HTTP lookups */
    private readonly missingSessionCache = new Set<string>();

    /**
     * Creates a new BackupManager.
     * @param machine The OlmMachine instance for crypto operations
     * @param client The MatrixClient for API requests
     * @param recoveryKey Optional recovery key for backup decryption.
     *   Supports both formats:
     *   - Base58 (human-readable): "EsTc LW2K PGiF wKEA 3As5 g5c4 BXwk qeeJ ZJV8 Q9fu gUMN UE4d"
     *   - Base64 (internal): "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo="
     */
    public constructor(
        private readonly machine: OlmMachine,
        private readonly client: MatrixClient,
        recoveryKey?: string,
    ) {
        // Automatically decode recovery key if provided
        if (recoveryKey) {
            try {
                this.recoveryKeyBase64 = BackupManager.decodeRecoveryKey(recoveryKey);
            } catch (e) {
                LogService.error("BackupManager", "Failed to decode recovery key:", e);
            }
        }
    }

    /**
     * Decode a recovery key from Base58 format to Base64.
     * Handles both Base58 (with spaces) and Base64 formats.
     *
     * Base58 format: "EsTc LW2K PGiF wKEA 3As5 g5c4 BXwk qeeJ ZJV8 Q9fu gUMN UE4d"
     * Base64 format: "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo="
     *
     * @param recoveryKey The recovery key in either format
     * @returns The recovery key in Base64 format
     */
    public static decodeRecoveryKey(recoveryKey: string): string {
        // Try Base64 first: if it decodes to exactly 32 bytes, it's a raw backup key
        if (!recoveryKey.includes(" ")) {
            try {
                const decoded = Buffer.from(recoveryKey, "base64");
                if (decoded.length === KEY_SIZE) {
                    // Verify it's actually base64 and not just coincidence by re-encoding
                    const reencoded = decoded.toString("base64");
                    if (reencoded === recoveryKey || reencoded.replace(/=+$/, "") === recoveryKey.replace(/=+$/, "")) {
                        return recoveryKey;
                    }
                }
            } catch {
                // Not valid base64, fall through to Base58
            }
        }

        // Decode from Base58
        const stripped = recoveryKey.replace(/ /g, "");
        const result = Array.from(bs58.decode(stripped));

        // Verify parity
        let parity = 0;
        for (const b of result) {
            parity ^= b;
        }
        if (parity !== 0) {
            throw new Error("Invalid recovery key: incorrect parity");
        }

        // Verify prefix
        for (let i = 0; i < OLM_RECOVERY_KEY_PREFIX.length; i++) {
            if (result[i] !== OLM_RECOVERY_KEY_PREFIX[i]) {
                throw new Error("Invalid recovery key: incorrect prefix");
            }
        }

        // Verify length
        if (result.length !== OLM_RECOVERY_KEY_PREFIX.length + KEY_SIZE + 1) {
            throw new Error("Invalid recovery key: incorrect length");
        }

        // Extract the key and convert to Base64
        const keyBytes = result.slice(OLM_RECOVERY_KEY_PREFIX.length, OLM_RECOVERY_KEY_PREFIX.length + KEY_SIZE);
        return Buffer.from(keyBytes).toString("base64");
    }

    /**
     * Stop the backup manager and cancel any pending operations.
     */
    public stop(): void {
        this.stopped = true;
    }

    /**
     * Get the currently active backup version, if any.
     */
    public async getActiveBackupVersion(): Promise<string | null> {
        if (!(await this.machine.isBackupEnabled())) return null;
        return this.activeBackupVersion;
    }

    /**
     * Check the server for a key backup and enable it if trusted.
     *
     * This method:
     * 1. Fetches the current backup version from the server
     * 2. Verifies the backup is trusted (either signed or matches our decryption key)
     * 3. Enables key backup if trusted
     * 4. Starts the background key upload loop
     *
     * @returns The backup info and trust status, or null if no backup exists
     */
    public async checkKeyBackupAndEnable(): Promise<{ backupInfo: KeyBackupInfo; trustInfo: BackupTrustInfo } | null> {
        LogService.debug("BackupManager", "Checking key backup status...");

        let backupInfo: KeyBackupInfo | null;
        try {
            backupInfo = await this.requestKeyBackupVersion();
        } catch (e) {
            LogService.warn("BackupManager", "Error checking for active key backup:", e);
            return null;
        }

        if (!backupInfo || !backupInfo.version) {
            const activeVersion = await this.getActiveBackupVersion();
            if (activeVersion !== null) {
                LogService.debug("BackupManager", "No key backup on server: disabling key backup");
                await this.disableKeyBackup();
            }

            // If we have a recovery key, create a new backup
            if (this.recoveryKeyBase64) {
                LogService.info("BackupManager", "No backup on server, creating new backup with configured recovery key");
                try {
                    backupInfo = await this.createBackupVersion();
                    LogService.info("BackupManager", `Created backup version ${backupInfo.version}`);
                    // Continue to enable the backup below
                } catch (e) {
                    LogService.error("BackupManager", "Failed to create backup:", e);
                    return null;
                }
            } else {
                LogService.debug("BackupManager", "No key backup on server and no recovery key configured");
                return null;
            }
        }

        const trustInfo = await this.isKeyBackupTrusted(backupInfo);

        // Enable if we have a matching decryption key or if it's signed by a trusted key
        if (!trustInfo.matchesDecryptionKey && !trustInfo.trusted) {
            const activeVersion = await this.getActiveBackupVersion();
            if (activeVersion !== null) {
                LogService.debug("BackupManager", "Key backup present but not trusted: disabling");
                await this.disableKeyBackup();
            } else {
                LogService.debug("BackupManager", "Key backup present but not trusted: not enabling");
            }
        } else {
            const activeVersion = await this.getActiveBackupVersion();
            if (activeVersion === null) {
                LogService.info("BackupManager", `Found usable key backup v${backupInfo.version}: enabling`);
                await this.enableKeyBackup(backupInfo);
            } else if (activeVersion !== backupInfo.version) {
                LogService.info("BackupManager", `Switching from backup v${activeVersion} to v${backupInfo.version}`);
                await this.disableKeyBackup();
                await this.enableKeyBackup(backupInfo);
            } else {
                LogService.debug("BackupManager", `Backup version ${backupInfo.version} still current`);
            }
        }

        return { backupInfo, trustInfo };
    }

    /**
     * Determine if a key backup can be trusted.
     *
     * @param info The key backup info from the server
     * @returns Trust information
     */
    public async isKeyBackupTrusted(info: KeyBackupInfo): Promise<BackupTrustInfo> {
        // Verify the backup signature
        const signatureVerification = await this.machine.verifyBackup(JSON.stringify(info));

        // Check if we have a matching decryption key
        let matchesDecryptionKey = false;
        if (this.recoveryKeyBase64) {
            try {
                const decryptionKey = BackupDecryptionKey.fromBase64(this.recoveryKeyBase64);
                const publicKey = decryptionKey.megolmV1PublicKey.publicKeyBase64;
                matchesDecryptionKey = publicKey === info.auth_data.public_key;
                if (matchesDecryptionKey) {
                    this.decryptionKey = decryptionKey;
                }
            } catch (e) {
                LogService.warn("BackupManager", "Error checking recovery key match:", e);
            }
        }

        return {
            matchesDecryptionKey,
            trusted: signatureVerification.trusted(),
        };
    }

    /**
     * Enable key backup with the given backup info.
     */
    private async enableKeyBackup(backupInfo: KeyBackupInfo): Promise<void> {
        await this.machine.enableBackupV1(
            backupInfo.auth_data.public_key,
            backupInfo.version,
        );
        this.activeBackupVersion = backupInfo.version;
        this.missingSessionCache.clear();

        // Save the decryption key if we have it
        if (this.decryptionKey) {
            await this.machine.saveBackupDecryptionKey(this.decryptionKey, backupInfo.version);
        }

        LogService.info("BackupManager", `Key backup enabled for version ${backupInfo.version}`);

        // Start the background upload loop
        this.backupKeysLoop();
    }

    /**
     * Disable key backup.
     */
    private async disableKeyBackup(): Promise<void> {
        await this.machine.disableBackup();
        this.activeBackupVersion = null;
        LogService.info("BackupManager", "Key backup disabled");
    }

    /**
     * Create a new backup version on the server using the configured recovery key.
     */
    private async createBackupVersion(): Promise<KeyBackupInfo> {
        if (!this.recoveryKeyBase64) {
            throw new Error("No recovery key configured");
        }

        // Derive public key from recovery key
        const decryptionKey = BackupDecryptionKey.fromBase64(this.recoveryKeyBase64);
        const publicKey = decryptionKey.megolmV1PublicKey.publicKeyBase64;

        // Create backup on server
        const response = await this.client.doRequest(
            "POST",
            "/_matrix/client/v3/room_keys/version",
            {},
            {
                algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
                auth_data: {
                    public_key: publicKey,
                },
            }
        ) as { version: string };

        // Store the decryption key
        this.decryptionKey = decryptionKey;

        return {
            algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
            auth_data: { public_key: publicKey },
            version: response.version,
        };
    }

    /**
     * Trigger a check for keys to upload. Call this after receiving new keys.
     */
    public async maybeUploadKey(): Promise<void> {
        if (this.activeBackupVersion !== null) {
            this.backupKeysLoop();
        }
    }

    /**
     * Background loop that continuously uploads room keys to the backup.
     *
     * This loop:
     * 1. Gets batches of keys from the OlmMachine
     * 2. Uploads them to the server
     * 3. Marks them as sent
     * 4. Repeats until no more keys need backup
     */
    private async backupKeysLoop(maxDelay = 10000): Promise<void> {
        if (this.backupLoopRunning) {
            return;
        }
        this.backupLoopRunning = true;

        // Random delay to avoid multiple clients hitting the server at once
        const delay = Math.random() * maxDelay;
        await this.sleep(delay);

        try {
            let numFailures = 0;
            let keysUploaded = 0;

            while (!this.stopped) {
                // Get a batch of room keys to upload
                let request: KeysBackupRequest | null = null;
                try {
                    request = await this.machine.backupRoomKeys();
                } catch (err) {
                    LogService.error("BackupManager", "Failed to get keys for backup:", err);
                }

                if (!request || this.stopped || !this.activeBackupVersion) {
                    // Only log if we actually uploaded keys
                    if (keysUploaded > 0) {
                        try {
                            const counts = await this.machine.roomKeyCounts();
                            LogService.info("BackupManager", `Backup complete: uploaded ${keysUploaded} keys (${counts.backedUp}/${counts.total} total backed up)`);
                        } catch (e) {
                            // Ignore count errors
                        }
                    }
                    return;
                }

                try {
                    // Upload the keys to the server
                    const response = await this.client.doRequest(
                        "PUT",
                        `/_matrix/client/v3/room_keys/keys`,
                        { version: this.activeBackupVersion },
                        JSON.parse(request.body),
                    );

                    // Mark the request as sent - must pass the actual server response with etag
                    await this.machine.markRequestAsSent(request.id, RequestType.KeysBackup, JSON.stringify(response));
                    keysUploaded++;
                    numFailures = 0;

                } catch (err: any) {
                    numFailures++;
                    LogService.error("BackupManager", "Error uploading keys to backup:", err);

                    // Check for specific error codes
                    if (err?.body?.errcode === "M_NOT_FOUND" || err?.body?.errcode === "M_WRONG_ROOM_KEYS_VERSION") {
                        LogService.warn("BackupManager", `Backup version mismatch: ${err?.body?.errcode}`);
                        try {
                            await this.disableKeyBackup();
                        } catch (e) {
                            LogService.error("BackupManager", "Error disabling backup:", e);
                        }
                        // Re-check backup on server
                        this.backupLoopRunning = false;
                        this.checkKeyBackupAndEnable();
                        return;
                    }

                    // Exponential backoff on other errors
                    const backoffMs = 1000 * Math.pow(2, Math.min(numFailures - 1, 4));
                    await this.sleep(backoffMs);
                }
            }
        } finally {
            this.backupLoopRunning = false;
        }
    }

    /**
     * Get the current backup version info from the server.
     *
     * @param version Optional specific version to fetch
     * @returns The backup info or null if no backup exists
     */
    public async requestKeyBackupVersion(version?: string): Promise<KeyBackupInfo | null> {
        try {
            const path = version
                ? `/_matrix/client/v3/room_keys/version/${encodeURIComponent(version)}`
                : "/_matrix/client/v3/room_keys/version";

            return await this.client.doRequest("GET", path);
        } catch (e: any) {
            if (e?.body?.errcode === "M_NOT_FOUND") {
                return null;
            }
            throw e;
        }
    }

    /**
     * Download all backed up keys from the server.
     *
     * @param backupVersion The backup version to download from
     * @returns The backed up keys organized by room and session
     */
    public async downloadKeyBackup(backupVersion: string): Promise<{
        rooms: Record<string, { sessions: Record<string, KeyBackupSessionData> }>;
    }> {
        return await this.client.doRequest(
            "GET",
            "/_matrix/client/v3/room_keys/keys",
            { version: backupVersion },
        );
    }

    /**
     * Download a specific session key from the backup.
     *
     * @param backupVersion The backup version
     * @param roomId The room ID
     * @param sessionId The session ID
     * @returns The session data or null if not found
     */
    public async downloadSessionKey(
        backupVersion: string,
        roomId: string,
        sessionId: string,
    ): Promise<KeyBackupSessionData | null> {
        try {
            return await this.client.doRequest(
                "GET",
                `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`,
                { version: backupVersion },
            );
        } catch (e: any) {
            if (e?.body?.errcode === "M_NOT_FOUND") {
                return null;
            }
            throw e;
        }
    }

    /**
     * Decrypt a session from the backup.
     *
     * @param sessionData The encrypted session data
     * @returns The decrypted session data as a JSON object
     */
    public decryptSession(sessionData: KeyBackupSessionData): Record<string, unknown> {
        if (!this.decryptionKey) {
            throw new Error("No decryption key available");
        }

        const decrypted = this.decryptionKey.decryptV1(
            sessionData.session_data.ephemeral,
            sessionData.session_data.mac,
            sessionData.session_data.ciphertext,
        );

        return JSON.parse(decrypted);
    }

    /**
     * Restore keys from backup.
     *
     * Downloads all backed up keys, decrypts them, and imports them into the OlmMachine.
     *
     * @param backupVersion Optional version to restore from (defaults to active version)
     * @returns The count of total and imported keys
     */
    public async restoreKeyBackup(backupVersion?: string): Promise<KeyBackupRestoreResult> {
        const version = backupVersion || this.activeBackupVersion;
        if (!version) {
            throw new Error("No backup version specified and no active backup");
        }

        if (!this.decryptionKey) {
            throw new Error("No decryption key available - provide recovery key during initialization");
        }

        LogService.info("BackupManager", `Restoring keys from backup v${version}`);

        const backup = await this.downloadKeyBackup(version);
        const keysToImport: ExportedRoomKey[] = [];
        let total = 0;
        let decrypted = 0;

        for (const [roomId, roomData] of Object.entries(backup.rooms || {})) {
            for (const [sessionId, sessionData] of Object.entries(roomData.sessions || {})) {
                total++;
                try {
                    // Decrypt the session
                    const decryptedSession = this.decryptSession(sessionData);
                    LogService.debug("BackupManager", `Decrypted key for room ${roomId} session ${sessionId}`);

                    // Build the exported room key format for import
                    const exportedKey: ExportedRoomKey = {
                        algorithm: decryptedSession.algorithm as string || "m.megolm.v1.aes-sha2",
                        room_id: roomId,
                        sender_key: decryptedSession.sender_key as string,
                        session_id: sessionId,
                        session_key: decryptedSession.session_key as string,
                        sender_claimed_keys: decryptedSession.sender_claimed_keys as Record<string, string> || {},
                        forwarding_curve25519_key_chain: decryptedSession.forwarding_curve25519_key_chain as string[] || [],
                    };

                    keysToImport.push(exportedKey);
                    decrypted++;
                } catch (e) {
                    LogService.warn("BackupManager", `Failed to decrypt session ${sessionId} in room ${roomId}:`, e);
                }
            }
        }

        LogService.info("BackupManager", `Decrypted ${decrypted}/${total} keys from backup`);

        // Import all decrypted keys into the OlmMachine
        if (keysToImport.length > 0) {
            try {
                const importResult: RoomKeyImportResult = await this.machine.importRoomKeys(
                    JSON.stringify(keysToImport),
                    version, // fromBackupVersion = backup version string
                );
                LogService.info("BackupManager", `Imported ${importResult.importedCount}/${importResult.totalCount} keys into OlmMachine`);
                return { total, imported: Number(importResult.importedCount) };
            } catch (e) {
                LogService.error("BackupManager", "Failed to import keys into OlmMachine:", e);
                throw e;
            }
        }

        return { total, imported: 0 };
    }

    /**
     * Import a single session key from backup.
     *
     * Downloads and imports a specific session key - useful for on-demand key recovery
     * when decryption fails due to a missing key.
     *
     * @param roomId The room ID
     * @param sessionId The session ID
     * @returns True if the key was successfully imported
     */
    public async importSessionKeyFromBackup(roomId: string, sessionId: string): Promise<boolean> {
        const version = this.activeBackupVersion;
        if (!version) {
            LogService.debug("BackupManager", "No active backup version for on-demand key fetch");
            return false;
        }

        if (!this.decryptionKey) {
            LogService.debug("BackupManager", "No decryption key for on-demand key fetch");
            return false;
        }

        const cacheKey = `${roomId}:${sessionId}`;
        if (this.missingSessionCache.has(cacheKey)) {
            LogService.debug("BackupManager", `Session ${sessionId} already known missing from backup, skipping`);
            return false;
        }

        LogService.info("BackupManager", `Fetching key for room ${roomId} session ${sessionId} from backup v${version}`);

        try {
            const sessionData = await this.downloadSessionKey(version, roomId, sessionId);
            if (!sessionData) {
                LogService.warn("BackupManager", `Key not found in backup for session ${sessionId}`);
                this.missingSessionCache.add(cacheKey);
                return false;
            }

            // Decrypt the session
            const decryptedSession = this.decryptSession(sessionData);

            // Build the exported room key format for import
            const exportedKey: ExportedRoomKey = {
                algorithm: decryptedSession.algorithm as string || "m.megolm.v1.aes-sha2",
                room_id: roomId,
                sender_key: decryptedSession.sender_key as string,
                session_id: sessionId,
                session_key: decryptedSession.session_key as string,
                sender_claimed_keys: decryptedSession.sender_claimed_keys as Record<string, string> || {},
                forwarding_curve25519_key_chain: decryptedSession.forwarding_curve25519_key_chain as string[] || [],
            };

            // Import the key
            const importResult = await this.machine.importRoomKeys(
                JSON.stringify([exportedKey]),
                version, // fromBackupVersion = backup version string
            );

            const success = importResult.importedCount > 0;
            if (success) {
                LogService.info("BackupManager", `Successfully imported key for session ${sessionId}`);
            } else {
                LogService.debug("BackupManager", `Key for session ${sessionId} already exists or could not be imported`);
            }

            return success;
        } catch (e) {
            LogService.warn("BackupManager", `Failed to import key for session ${sessionId}:`, e);
            return false;
        }
    }

    /**
     * Get the current room key counts.
     */
    public async getRoomKeyCounts(): Promise<{ total: number; backedUp: number }> {
        const counts = await this.machine.roomKeyCounts();
        return {
            total: counts.total,
            backedUp: counts.backedUp,
        };
    }

    /**
     * Check if key backup is currently enabled.
     */
    public async isBackupEnabled(): Promise<boolean> {
        return await this.machine.isBackupEnabled();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
