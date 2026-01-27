import HttpBackend from "matrix-mock-request";
import { BackupDecryptionKey } from "@ixo/matrix-sdk-crypto-nodejs";

import { MatrixClient, setRequestFn } from "../../src";
import { BackupManager, KeyBackupInfo, KeyBackupSessionData } from "../../src/e2ee/BackupManager";

// Test fixtures from matrix-js-sdk - cryptographically valid and interoperable
// These are generated test data that can actually be decrypted

/** base64-encoded backup decryption (private) key */
const BACKUP_DECRYPTION_KEY_BASE64 = "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=";

/** Signed backup data, suitable for return from `GET /_matrix/client/v3/room_keys/version` */
const SIGNED_BACKUP_DATA: KeyBackupInfo = {
    algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
    version: "1",
    auth_data: {
        public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
        signatures: {
            "@alice:localhost": {
                "ed25519:test_device": "KDSNeumirTsd8piI0oVfv/wzg4J4HlEc7rs5XhODFcJ/YAcUdg65ajsZG+rLI0TQOSSGjorJqcrSiSB1HRSCAA",
            },
        },
    },
};

/** The key from MEGOLM_SESSION_DATA, encrypted for backup using curve25519 algorithm */
const CURVE25519_KEY_BACKUP_DATA: KeyBackupSessionData = {
    first_message_index: 1,
    forwarded_count: 0,
    is_verified: false,
    session_data: {
        ciphertext:
            "r6HRk2/Im2yJe5cLP8R81aVjFWjYWPHpw7TVxphiSK1cdIDZTTK57r6MfU+0i/mTPn+/PosT74OvYwCnehy2d1BPGxhDl8AhPcBu3//Kzlq2o5CssPsw+88gRehkAsPg9Zp5G9sL9to6giltvTWTbsaQpmvv3HLmBOYSFIxvyZrOT/Ffqu325f0IEsKcyV2BdIkw8Ob9Xt+VWoe4MYEGG6y1T8W125zeFgKWI4Ow76uput64H9zZjIo+Cc+hCTO9Ea4EnosSjizCotevkNck7C/zGgfhBikiohROb6SbaZgxicSsEDZ+f7brnri9yP3iXS3PMDHHpa1+XzG2VOG/Y9OQZpkPq+pbLrCC+NWJeJPslDAK5i+RURwzjnPmaHKCRHTq86CwhFyiCDf61MGwCY3xjrmBJg44BCdxWqCx0YJvwsvVqqnl4vTieUfrwThNPsQ81aVkDHvlmrgrTt8icDa8jTJhu34jem+pbRSEM5aJikV4B+zYiLz+dH/v6UpYA2eG8ReOvwpPXp6CAcIlplRPpWbMBeLFVcPkT4KAXTp9exFpB4on4pf8OsaDomlt4qAA0rhAZmhPWPKcU/A0Tz4gyMu54OivVtw1SPj+5Iq+YDQ8jB6Po3ApzMf6fwF9x/FjevbboFB05X2Jr0NrbFqXMOUwXHMgDAGiIWX8+gkmmbaiNWqg2etjN94pobQSGZelb18XGN7kuwMk+Zwk7A",
        ephemeral: "q+P1WdRtEiPIEtNuuGrRcueZxUbLnSKdsuTAkxewXgU",
        mac: "OibmACbORhI",
    },
};

/** Expected decrypted megolm session data */
const MEGOLM_SESSION_DATA = {
    algorithm: "m.megolm.v1.aes-sha2",
    room_id: "!room:id",
    sender_key: "WimPd2udAU/1S/+YBpPbmr9L+0H5H+BnAVHSwDxlPGc",
    session_id: "ipdI6Zs/7DzFTEhiA2iGaMDfHkIYCleqXT6L+5e1/co",
    session_key:
        "AQAAAABXGO+Z9jlQJhIL6ByhXrv2BwCIxkhh7MXpKLsYmXkJcWrQlirmXmD79ga1zo+I4DCtEZzyGSpDWXBC6G7ez3H4gDMBam1RE3Jm5tc+oTlIri32UkYgSL0kBkcEnttqmIXBlK8tAfJo3cJnlh7F4ltEOAqrdME6dU0zXTkqXmURqYqXSOmbP+w8xUxIYgNohmjA3x5CGApXql0+i/uXtf3K",
    sender_claimed_keys: {
        ed25519: "Bhbpt6hqMZlSH4sJV7xiEEEiPVeTWz4Vkujl1EMdIPI",
    },
    forwarding_curve25519_key_chain: [],
};

/**
 * Create a mock OlmMachine for testing BackupManager
 */
function createMockMachine() {
    return {
        isBackupEnabled: jest.fn().mockResolvedValue(false),
        enableBackupV1: jest.fn().mockResolvedValue(undefined),
        disableBackup: jest.fn().mockResolvedValue(undefined),
        verifyBackup: jest.fn().mockResolvedValue({ trusted: () => false }),
        saveBackupDecryptionKey: jest.fn().mockResolvedValue(undefined),
        backupRoomKeys: jest.fn().mockResolvedValue(null),
        roomKeyCounts: jest.fn().mockResolvedValue({ total: 0, backedUp: 0 }),
        markRequestAsSent: jest.fn().mockResolvedValue(undefined),
        importRoomKeys: jest.fn().mockResolvedValue({ importedCount: BigInt(0), totalCount: BigInt(0), keys: {} }),
    };
}

/**
 * Create a mock MatrixClient for testing
 */
function createMockClient(): { client: MatrixClient; http: HttpBackend } {
    const http = new HttpBackend();
    const hsUrl = "https://localhost";
    const accessToken = "s3cret";
    const client = new MatrixClient(hsUrl, accessToken);
    setRequestFn(http.requestFn);
    return { client, http };
}

describe("BackupManager", () => {
    describe("checkKeyBackupAndEnable", () => {
        it("should not enable backup when no backup exists on server", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();

            const manager = new BackupManager(mockMachine as any, client);

            // Server returns 404 - no backup
            http.when("GET", "/_matrix/client/v3/room_keys/version").respond(404, {
                errcode: "M_NOT_FOUND",
                error: "No current backup version",
            });

            const resultPromise = manager.checkKeyBackupAndEnable();
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBeNull();
            expect(mockMachine.enableBackupV1).not.toHaveBeenCalled();
        });

        it("should enable backup when server has matching backup version", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();

            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            http.when("GET", "/_matrix/client/v3/room_keys/version").respond(200, SIGNED_BACKUP_DATA);

            const resultPromise = manager.checkKeyBackupAndEnable();
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBeDefined();
            expect(result!.backupInfo.version).toBe("1");
            expect(result!.trustInfo.matchesDecryptionKey).toBe(true);
            expect(mockMachine.enableBackupV1).toHaveBeenCalledTimes(1);
            expect(mockMachine.enableBackupV1).toHaveBeenCalledWith(
                SIGNED_BACKUP_DATA.auth_data.public_key,
                "1",
            );

            // Clean up background loop
            manager.stop();
        });

        it("should not enable backup when public key does not match recovery key", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();

            // Use a different (random) recovery key that won't match the backup's public key
            const differentKey = BackupDecryptionKey.createRandomKey();
            const manager = new BackupManager(mockMachine as any, client, differentKey.toBase64());

            http.when("GET", "/_matrix/client/v3/room_keys/version").respond(200, SIGNED_BACKUP_DATA);

            const resultPromise = manager.checkKeyBackupAndEnable();
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBeDefined();
            expect(result!.trustInfo.matchesDecryptionKey).toBe(false);
            expect(result!.trustInfo.trusted).toBe(false);
            // Should NOT enable backup since neither trusted nor matching key
            expect(mockMachine.enableBackupV1).not.toHaveBeenCalled();
        });

        it("should enable backup when backup is signed by trusted key", async () => {
            const mockMachine = createMockMachine();
            // Make verifyBackup return trusted
            mockMachine.verifyBackup = jest.fn().mockResolvedValue({ trusted: () => true });

            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client); // No recovery key

            http.when("GET", "/_matrix/client/v3/room_keys/version").respond(200, SIGNED_BACKUP_DATA);

            const resultPromise = manager.checkKeyBackupAndEnable();
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBeDefined();
            expect(result!.trustInfo.trusted).toBe(true);
            expect(mockMachine.enableBackupV1).toHaveBeenCalledTimes(1);

            // Clean up background loop
            manager.stop();
        });

        it("should disable existing backup when server backup is not trusted", async () => {
            const mockMachine = createMockMachine();
            // Start with backup enabled
            mockMachine.isBackupEnabled = jest.fn().mockResolvedValue(true);

            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);
            // Manually set active version to simulate enabled state
            (manager as any).activeBackupVersion = "1";

            const backupInfo: KeyBackupInfo = {
                algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
                auth_data: { public_key: "untrusted_key" },
                version: "2", // Different version
            };

            http.when("GET", "/_matrix/client/v3/room_keys/version").respond(200, backupInfo);

            const resultPromise = manager.checkKeyBackupAndEnable();
            await http.flushAllExpected();
            await resultPromise;

            expect(mockMachine.disableBackup).toHaveBeenCalledTimes(1);
        });
    });

    describe("restoreKeyBackup", () => {
        it("should download and import all backed up keys", async () => {
            const mockMachine = createMockMachine();
            mockMachine.importRoomKeys = jest.fn().mockResolvedValue({
                importedCount: BigInt(1),
                totalCount: BigInt(1),
                keys: {},
            });

            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            // Set up manager state - simulate backup already enabled
            (manager as any).activeBackupVersion = "1";
            (manager as any).decryptionKey = BackupDecryptionKey.fromBase64(BACKUP_DECRYPTION_KEY_BASE64);

            const backupData = {
                rooms: {
                    "!room:id": {
                        sessions: {
                            [MEGOLM_SESSION_DATA.session_id]: CURVE25519_KEY_BACKUP_DATA,
                        },
                    },
                },
            };

            http.when("GET", "/_matrix/client/v3/room_keys/keys").respond(200, backupData);

            const resultPromise = manager.restoreKeyBackup();
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result.total).toBe(1);
            expect(result.imported).toBe(1);
            expect(mockMachine.importRoomKeys).toHaveBeenCalledTimes(1);

            // Verify the imported keys format
            const importedKeys = JSON.parse(mockMachine.importRoomKeys.mock.calls[0][0]);
            expect(importedKeys.length).toBe(1);
            expect(importedKeys[0].room_id).toBe("!room:id");
            expect(importedKeys[0].session_id).toBe(MEGOLM_SESSION_DATA.session_id);
            expect(importedKeys[0].algorithm).toBe("m.megolm.v1.aes-sha2");
        });

        it("should return correct counts for partial imports", async () => {
            const mockMachine = createMockMachine();
            // Simulate some keys already imported (importedCount < totalCount)
            mockMachine.importRoomKeys = jest.fn().mockResolvedValue({
                importedCount: BigInt(1),
                totalCount: BigInt(2),
                keys: {},
            });

            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            (manager as any).activeBackupVersion = "1";
            (manager as any).decryptionKey = BackupDecryptionKey.fromBase64(BACKUP_DECRYPTION_KEY_BASE64);

            // Two sessions using same encrypted data for simplicity
            const backupData = {
                rooms: {
                    "!room:id": {
                        sessions: {
                            session1: CURVE25519_KEY_BACKUP_DATA,
                            session2: CURVE25519_KEY_BACKUP_DATA,
                        },
                    },
                },
            };

            http.when("GET", "/_matrix/client/v3/room_keys/keys").respond(200, backupData);

            const resultPromise = manager.restoreKeyBackup();
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result.total).toBe(2);
            expect(result.imported).toBe(1);
        });

        it("should throw when no recovery key is configured", async () => {
            const mockMachine = createMockMachine();
            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client); // No recovery key

            (manager as any).activeBackupVersion = "1";

            await expect(manager.restoreKeyBackup()).rejects.toThrow(
                "No decryption key available - provide recovery key during initialization",
            );
        });

        it("should throw when no backup version specified and no active backup", async () => {
            const mockMachine = createMockMachine();
            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            // No active backup version set
            await expect(manager.restoreKeyBackup()).rejects.toThrow(
                "No backup version specified and no active backup",
            );
        });

        it("should handle empty backup gracefully", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            (manager as any).activeBackupVersion = "1";
            (manager as any).decryptionKey = BackupDecryptionKey.fromBase64(BACKUP_DECRYPTION_KEY_BASE64);

            // Empty backup
            const backupData = { rooms: {} };

            http.when("GET", "/_matrix/client/v3/room_keys/keys").respond(200, backupData);

            const resultPromise = manager.restoreKeyBackup();
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result.total).toBe(0);
            expect(result.imported).toBe(0);
            expect(mockMachine.importRoomKeys).not.toHaveBeenCalled();
        });
    });

    describe("importSessionKeyFromBackup", () => {
        it("should fetch and import a single session key", async () => {
            const mockMachine = createMockMachine();
            mockMachine.importRoomKeys = jest.fn().mockResolvedValue({
                importedCount: BigInt(1),
                totalCount: BigInt(1),
                keys: {},
            });

            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            (manager as any).activeBackupVersion = "1";
            (manager as any).decryptionKey = BackupDecryptionKey.fromBase64(BACKUP_DECRYPTION_KEY_BASE64);

            const roomId = "!room:id";
            const sessionId = MEGOLM_SESSION_DATA.session_id;

            http.when(
                "GET",
                `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`,
            ).respond(200, CURVE25519_KEY_BACKUP_DATA);

            const resultPromise = manager.importSessionKeyFromBackup(roomId, sessionId);
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBe(true);
            expect(mockMachine.importRoomKeys).toHaveBeenCalledTimes(1);

            const importedKeys = JSON.parse(mockMachine.importRoomKeys.mock.calls[0][0]);
            expect(importedKeys.length).toBe(1);
            expect(importedKeys[0].room_id).toBe(roomId);
            expect(importedKeys[0].session_id).toBe(sessionId);
        });

        it("should return false when key not found in backup", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            (manager as any).activeBackupVersion = "1";
            (manager as any).decryptionKey = BackupDecryptionKey.fromBase64(BACKUP_DECRYPTION_KEY_BASE64);

            const roomId = "!room:example.org";
            const sessionId = "nonexistent_session";

            http.when(
                "GET",
                `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`,
            ).respond(404, { errcode: "M_NOT_FOUND", error: "Key not found" });

            const resultPromise = manager.importSessionKeyFromBackup(roomId, sessionId);
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBe(false);
            expect(mockMachine.importRoomKeys).not.toHaveBeenCalled();
        });

        it("should return false when backup not enabled", async () => {
            const mockMachine = createMockMachine();
            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            // No active backup version
            const result = await manager.importSessionKeyFromBackup("!room:example.org", "session");

            expect(result).toBe(false);
        });

        it("should return false when no decryption key available", async () => {
            const mockMachine = createMockMachine();
            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client); // No recovery key

            (manager as any).activeBackupVersion = "1";
            // No decryption key

            const result = await manager.importSessionKeyFromBackup("!room:example.org", "session");

            expect(result).toBe(false);
        });

        it("should return false when key is already imported", async () => {
            const mockMachine = createMockMachine();
            // Key already exists, so importedCount is 0
            mockMachine.importRoomKeys = jest.fn().mockResolvedValue({
                importedCount: BigInt(0),
                totalCount: BigInt(1),
                keys: {},
            });

            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            (manager as any).activeBackupVersion = "1";
            (manager as any).decryptionKey = BackupDecryptionKey.fromBase64(BACKUP_DECRYPTION_KEY_BASE64);

            const roomId = "!room:id";
            const sessionId = MEGOLM_SESSION_DATA.session_id;

            http.when(
                "GET",
                `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`,
            ).respond(200, CURVE25519_KEY_BACKUP_DATA);

            const resultPromise = manager.importSessionKeyFromBackup(roomId, sessionId);
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBe(false);
        });
    });

    describe("isKeyBackupTrusted", () => {
        it("should return matchesDecryptionKey true when recovery key matches", async () => {
            const mockMachine = createMockMachine();
            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            const result = await manager.isKeyBackupTrusted(SIGNED_BACKUP_DATA);

            expect(result.matchesDecryptionKey).toBe(true);
        });

        it("should return matchesDecryptionKey false when recovery key does not match", async () => {
            const differentKey = BackupDecryptionKey.createRandomKey();
            const mockMachine = createMockMachine();
            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, differentKey.toBase64());

            const result = await manager.isKeyBackupTrusted(SIGNED_BACKUP_DATA);

            expect(result.matchesDecryptionKey).toBe(false);
        });

        it("should return trusted status from signature verification", async () => {
            const mockMachine = createMockMachine();
            mockMachine.verifyBackup = jest.fn().mockResolvedValue({ trusted: () => true });

            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            const result = await manager.isKeyBackupTrusted(SIGNED_BACKUP_DATA);

            expect(result.trusted).toBe(true);
            expect(mockMachine.verifyBackup).toHaveBeenCalledTimes(1);
        });
    });

    describe("decryptSession", () => {
        it("should decrypt session data with correct key", () => {
            const mockMachine = createMockMachine();
            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client, BACKUP_DECRYPTION_KEY_BASE64);

            // Set decryption key
            (manager as any).decryptionKey = BackupDecryptionKey.fromBase64(BACKUP_DECRYPTION_KEY_BASE64);

            const decrypted = manager.decryptSession(CURVE25519_KEY_BACKUP_DATA);

            expect(decrypted.algorithm).toBe("m.megolm.v1.aes-sha2");
            expect(decrypted.sender_key).toBe(MEGOLM_SESSION_DATA.sender_key);
            expect(decrypted.session_key).toBeDefined();
        });

        it("should throw when no decryption key available", () => {
            const mockMachine = createMockMachine();
            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            // No decryption key
            expect(() => manager.decryptSession(CURVE25519_KEY_BACKUP_DATA)).toThrow(
                "No decryption key available",
            );
        });
    });

    describe("downloadSessionKey", () => {
        it("should return session data for existing key", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            const roomId = "!room:id";
            const sessionId = MEGOLM_SESSION_DATA.session_id;

            http.when(
                "GET",
                `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`,
            ).respond(200, CURVE25519_KEY_BACKUP_DATA);

            const resultPromise = manager.downloadSessionKey("1", roomId, sessionId);
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBeDefined();
            expect(result!.session_data).toBeDefined();
            expect(result!.session_data.ciphertext).toBe(CURVE25519_KEY_BACKUP_DATA.session_data.ciphertext);
        });

        it("should return null when key not found", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            const roomId = "!room:example.org";
            const sessionId = "nonexistent";

            http.when(
                "GET",
                `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`,
            ).respond(404, { errcode: "M_NOT_FOUND", error: "Key not found" });

            const resultPromise = manager.downloadSessionKey("1", roomId, sessionId);
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBeNull();
        });
    });

    describe("stop", () => {
        it("should stop the backup loop", async () => {
            const mockMachine = createMockMachine();
            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            manager.stop();

            expect((manager as any).stopped).toBe(true);
        });
    });

    describe("getRoomKeyCounts", () => {
        it("should return key counts from machine", async () => {
            const mockMachine = createMockMachine();
            mockMachine.roomKeyCounts = jest.fn().mockResolvedValue({ total: 10, backedUp: 5 });

            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            const counts = await manager.getRoomKeyCounts();

            expect(counts.total).toBe(10);
            expect(counts.backedUp).toBe(5);
        });
    });

    describe("isBackupEnabled", () => {
        it("should return backup status from machine", async () => {
            const mockMachine = createMockMachine();
            mockMachine.isBackupEnabled = jest.fn().mockResolvedValue(true);

            const { client } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            const enabled = await manager.isBackupEnabled();

            expect(enabled).toBe(true);
        });
    });

    describe("requestKeyBackupVersion", () => {
        it("should fetch backup version from server", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            http.when("GET", "/_matrix/client/v3/room_keys/version").respond(200, SIGNED_BACKUP_DATA);

            const resultPromise = manager.requestKeyBackupVersion();
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBeDefined();
            expect(result!.version).toBe("1");
            expect(result!.algorithm).toBe("m.megolm_backup.v1.curve25519-aes-sha2");
        });

        it("should fetch specific backup version", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            http.when("GET", "/_matrix/client/v3/room_keys/version/2").respond(200, {
                ...SIGNED_BACKUP_DATA,
                version: "2",
            });

            const resultPromise = manager.requestKeyBackupVersion("2");
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBeDefined();
            expect(result!.version).toBe("2");
        });

        it("should return null when no backup exists", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            http.when("GET", "/_matrix/client/v3/room_keys/version").respond(404, {
                errcode: "M_NOT_FOUND",
                error: "No current backup version",
            });

            const resultPromise = manager.requestKeyBackupVersion();
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result).toBeNull();
        });
    });

    describe("downloadKeyBackup", () => {
        it("should download all backed up keys", async () => {
            const mockMachine = createMockMachine();
            const { client, http } = createMockClient();
            const manager = new BackupManager(mockMachine as any, client);

            const backupData = {
                rooms: {
                    "!room:id": {
                        sessions: {
                            [MEGOLM_SESSION_DATA.session_id]: CURVE25519_KEY_BACKUP_DATA,
                        },
                    },
                },
            };

            http.when("GET", "/_matrix/client/v3/room_keys/keys").respond(200, backupData);

            const resultPromise = manager.downloadKeyBackup("1");
            await http.flushAllExpected();
            const result = await resultPromise;

            expect(result.rooms).toBeDefined();
            expect(result.rooms["!room:id"]).toBeDefined();
            expect(result.rooms["!room:id"].sessions[MEGOLM_SESSION_DATA.session_id]).toBeDefined();
        });
    });
});
