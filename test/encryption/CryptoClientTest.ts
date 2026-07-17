import * as simple from "simple-mock";
import HttpBackend from 'matrix-mock-request';
import { RoomId } from "@ixo/matrix-sdk-crypto-nodejs";

import { EncryptedFile, MatrixClient, MembershipEvent, OTKAlgorithm, RoomEncryptionAlgorithm } from "../../src";
import { createTestClient, testCryptoStores, TEST_DEVICE_ID } from "../TestUtils";

export function bindNullEngine(http: HttpBackend) {
    http.when("POST", "/keys/upload").respond(200, (path, obj) => {
        expect(obj).toMatchObject({

        });
        return {
            one_time_key_counts: {
                // Enough to trick the OlmMachine into thinking it has enough keys
                [OTKAlgorithm.Signed]: 1000,
            },
        };
    });
    // Some oddity with the rust-sdk bindings during setup
    http.when("POST", "/keys/query").respond(200, (path, obj) => {
        return {};
    });
}

describe('CryptoClient', () => {
    it('should not have a device ID or be ready until prepared', () => testCryptoStores(async (cryptoStoreType) => {
        const userId = "@alice:example.org";
        const { client, http } = createTestClient(null, userId, cryptoStoreType);

        client.getWhoAmI = () => Promise.resolve({ user_id: userId, device_id: TEST_DEVICE_ID });

        expect(client.crypto).toBeDefined();
        expect(client.crypto.clientDeviceId).toBeFalsy();
        expect(client.crypto.isReady).toEqual(false);

        bindNullEngine(http);
        await Promise.all([
            client.crypto.prepare([]),
            http.flushAllExpected(),
        ]);

        expect(client.crypto.clientDeviceId).toEqual(TEST_DEVICE_ID);
        expect(client.crypto.isReady).toEqual(true);
    }));

    describe('prepare', () => {
        it('should schedule a deferred room scan without blocking startup', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const roomIds = ["!a:example.org", "!b:example.org"];
            const { client, http } = createTestClient(null, userId, cryptoStoreType);

            client.getWhoAmI = () => Promise.resolve({ user_id: userId, device_id: TEST_DEVICE_ID });
            client.getJoinedRooms = () => Promise.resolve(roomIds);

            // The scan never resolves: if it were on the startup path,
            // crypto.prepare below would hang instead of resolving.
            const prepareSpy = simple.stub().callFn((rids: string[]) => {
                expect(rids).toEqual(roomIds);
                return new Promise(() => void 0);
            });
            (<any>client.crypto).roomTracker.prepare = prepareSpy; // private member access
            (<any>client.crypto).roomScanDelayMs = 5;

            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare(roomIds),
                http.flushAllExpected(),
            ]);
            expect(client.crypto.isReady).toEqual(true);

            await new Promise(r => setTimeout(r, 50));
            expect(prepareSpy.callCount).toEqual(1); // ran deferred, exactly once
        }));

        it('should contain a failing deferred room scan', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const { client, http } = createTestClient(null, userId, cryptoStoreType);

            client.getWhoAmI = () => Promise.resolve({ user_id: userId, device_id: TEST_DEVICE_ID });
            client.getJoinedRooms = () => Promise.resolve([]);

            (<any>client.crypto).roomTracker.prepare = () => Promise.reject(new Error("Simulated failure"));
            (<any>client.crypto).roomScanDelayMs = 5;

            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare(["!a:example.org"]),
                http.flushAllExpected(),
            ]);
            expect(client.crypto.isReady).toEqual(true);
            await new Promise(r => setTimeout(r, 50));
            // No assertion beyond "no unhandled rejection".
        }));

        it('should not run the deferred room scan when cancelled', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const { client, http } = createTestClient(null, userId, cryptoStoreType);

            client.getWhoAmI = () => Promise.resolve({ user_id: userId, device_id: TEST_DEVICE_ID });
            client.getJoinedRooms = () => Promise.resolve([]);

            const prepareSpy = simple.stub().callFn(() => Promise.resolve());
            (<any>client.crypto).roomTracker.prepare = prepareSpy;
            // Long delay so the timer cannot fire during machine init; the
            // cancellation is verified via the cleared handle plus a short wait.
            (<any>client.crypto).roomScanDelayMs = 5000;

            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare(["!a:example.org"]),
                http.flushAllExpected(),
            ]);
            expect((<any>client.crypto).roomScanTimer).toBeTruthy();
            client.crypto.cancelDeferredRoomScan();
            expect((<any>client.crypto).roomScanTimer).toBeNull();

            await new Promise(r => setTimeout(r, 30));
            expect(prepareSpy.callCount).toEqual(0);
        }));

        it('should use a stored device ID', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const { client, http } = createTestClient(null, userId, cryptoStoreType);

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

            const whoamiSpy = simple.stub().callFn(() => Promise.resolve({ user_id: userId, device_id: "wrong" }));
            client.getWhoAmI = whoamiSpy;

            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);
            expect(whoamiSpy.callCount).toEqual(0);
            expect(client.crypto.clientDeviceId).toEqual(TEST_DEVICE_ID);
        }));

        it('should expose the device Ed25519 identity', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const { client, http } = createTestClient(null, userId, cryptoStoreType);

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);
            expect(client.crypto.clientDeviceEd25519).toBeTruthy();
        }));
    });

    describe('isRoomEncrypted', () => {
        it('should fail when the crypto has not been prepared', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const { client } = createTestClient(null, userId, cryptoStoreType);

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            // await client.crypto.prepare([]); // deliberately commented

            try {
                await client.crypto.isRoomEncrypted("!new:example.org");

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption has not initialized");
            }
        }));

        it('should return false for unknown rooms', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const { client, http } = createTestClient(null, userId, cryptoStoreType);

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            client.getRoomStateEvent = () => Promise.reject(new Error("not used"));

            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            const result = await client.crypto.isRoomEncrypted("!new:example.org");
            expect(result).toEqual(false);
        }));

        it('should return false for unencrypted rooms', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const { client, http } = createTestClient(null, userId, cryptoStoreType);

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            client.getRoomStateEvent = () => Promise.reject(new Error("implied 404"));

            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            const result = await client.crypto.isRoomEncrypted("!new:example.org");
            expect(result).toEqual(false);
        }));

        it('should return true for encrypted rooms (redacted state)', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const { client, http } = createTestClient(null, userId, cryptoStoreType);

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            client.getRoomStateEvent = () => Promise.resolve({});

            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            const result = await client.crypto.isRoomEncrypted("!new:example.org");
            expect(result).toEqual(true);
        }));

        it('should return true for encrypted rooms', () => testCryptoStores(async (cryptoStoreType) => {
            const userId = "@alice:example.org";
            const { client, http } = createTestClient(null, userId, cryptoStoreType);

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            client.getRoomStateEvent = () => Promise.resolve({ algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 });

            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            const result = await client.crypto.isRoomEncrypted("!new:example.org");
            expect(result).toEqual(true);
        }));
    });

    describe('sign', () => {
        const userId = "@alice:example.org";
        let client: MatrixClient;
        let http: HttpBackend;

        beforeEach(() => testCryptoStores(async (cryptoStoreType) => {
            const { client: mclient, http: mhttp } = createTestClient(null, userId, cryptoStoreType);
            client = mclient;
            http = mhttp;

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

            // client crypto not prepared for the one test which wants that state
        }));

        it('should fail when the crypto has not been prepared', async () => {
            try {
                await client.crypto.sign({ doesnt: "matter" });

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption has not initialized");
            }
        });

        it('should sign the object while retaining signatures without mutation', async () => {
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            const obj = {
                sign: "me",
                signatures: {
                    "@another:example.org": {
                        "ed25519:DEVICE": "signature goes here",
                    },
                },
                unsigned: {
                    not: "included",
                },
            };

            const signatures = await client.crypto.sign(obj);
            expect(signatures).toMatchObject({
                [userId]: {
                    [`ed25519:${TEST_DEVICE_ID}`]: expect.any(String),
                },
                ...obj.signatures,
            });
            expect(obj['signatures']).toBeDefined();
            expect(obj['unsigned']).toBeDefined();
        });
    });

    describe('encryptRoomEvent', () => {
        const userId = "@alice:example.org";
        let client: MatrixClient;
        let http: HttpBackend;

        beforeEach(() => testCryptoStores(async (cryptoStoreType) => {
            const { client: mclient, http: mhttp } = createTestClient(null, userId, cryptoStoreType);
            client = mclient;
            http = mhttp;

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

            // client crypto not prepared for the one test which wants that state
        }));

        it('should fail when the crypto has not been prepared', async () => {
            try {
                await client.crypto.encryptRoomEvent("!room:example.org", "org.example", {});

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption has not initialized");
            }
        });

        it('should fail in unencrypted rooms', async () => {
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            // Force unencrypted rooms
            client.crypto.isRoomEncrypted = async () => false;

            try {
                await client.crypto.encryptRoomEvent("!room:example.org", "type", {});

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("Room is not encrypted");
            }
        });

        it.skip('should get devices for invited members', async () => {
            // TODO: Support invited members, if history visibility would allow.
        });
    });

    describe('decryptRoomEvent', () => {
        const userId = "@alice:example.org";
        let client: MatrixClient;

        beforeEach(() => testCryptoStores(async (cryptoStoreType) => {
            const { client: mclient } = createTestClient(null, userId, cryptoStoreType);
            client = mclient;

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

            // client crypto not prepared for the one test which wants that state
        }));

        it('should fail when the crypto has not been prepared', async () => {
            try {
                await client.crypto.decryptRoomEvent(null, null);

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption has not initialized");
            }
        });

        // Tests for backup recovery - these test the logic without requiring full crypto setup
        describe('backup recovery logic', () => {
            it('should attempt key recovery when decryption fails with missing key error', () => testCryptoStores(async (cryptoStoreType) => {
                const { client, http } = createTestClient(null, userId, cryptoStoreType);
                await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

                bindNullEngine(http);
                await Promise.all([
                    client.crypto.prepare([]),
                    http.flushAllExpected(),
                ]);

                const mockEvent = {
                    raw: {
                        type: "m.room.encrypted",
                        room_id: "!room:example.org",
                        content: {
                            algorithm: "m.megolm.v1.aes-sha2",
                            session_id: "test_session",
                            ciphertext: "encrypted",
                        },
                    },
                    megolmProperties: {
                        session_id: "test_session",
                    },
                };

                // Mock backup manager
                const mockBackupManager = {
                    importSessionKeyFromBackup: simple.stub().resolveWith(false),
                };
                (client.crypto as any).backupManager = mockBackupManager;

                // Mock doDecryptRoomEvent to fail with missing key error
                let decryptCallCount = 0;
                (client.crypto as any).doDecryptRoomEvent = simple.stub().callFn(() => {
                    decryptCallCount++;
                    throw new Error("MegolmDecryptionError: Unable to decrypt message");
                });

                try {
                    await client.crypto.decryptRoomEvent(mockEvent as any, "!room:example.org");
                    throw new Error("Should have thrown");
                } catch (e) {
                    // Should have attempted backup recovery
                    expect(mockBackupManager.importSessionKeyFromBackup.callCount).toBe(1);
                    expect(mockBackupManager.importSessionKeyFromBackup.lastCall.args[0]).toBe("!room:example.org");
                    expect(mockBackupManager.importSessionKeyFromBackup.lastCall.args[1]).toBe("test_session");
                }
            }));

            it('should retry decryption after successful key recovery', () => testCryptoStores(async (cryptoStoreType) => {
                const { client, http } = createTestClient(null, userId, cryptoStoreType);
                await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

                bindNullEngine(http);
                await Promise.all([
                    client.crypto.prepare([]),
                    http.flushAllExpected(),
                ]);

                const mockEvent = {
                    raw: {
                        type: "m.room.encrypted",
                        room_id: "!room:example.org",
                        content: {
                            algorithm: "m.megolm.v1.aes-sha2",
                            session_id: "test_session",
                            ciphertext: "encrypted",
                        },
                    },
                    megolmProperties: {
                        session_id: "test_session",
                    },
                };

                // Mock backup manager that successfully imports
                const mockBackupManager = {
                    importSessionKeyFromBackup: simple.stub().resolveWith(true),
                };
                (client.crypto as any).backupManager = mockBackupManager;

                // Mock doDecryptRoomEvent to fail first, then succeed
                let decryptCallCount = 0;
                const decryptedEvent = {
                    raw: {
                        type: "m.room.message",
                        room_id: "!room:example.org",
                        content: { body: "Hello" },
                    },
                };
                (client.crypto as any).doDecryptRoomEvent = simple.stub().callFn(() => {
                    decryptCallCount++;
                    if (decryptCallCount === 1) {
                        throw new Error("MegolmDecryptionError: Unable to decrypt message");
                    }
                    return decryptedEvent;
                });

                const result = await client.crypto.decryptRoomEvent(mockEvent as any, "!room:example.org");

                // Should have retried after successful key import
                expect(decryptCallCount).toBe(2);
                expect(mockBackupManager.importSessionKeyFromBackup.callCount).toBe(1);
                expect(result).toBe(decryptedEvent);
            }));

            it('should not attempt recovery when backup manager is not configured', () => testCryptoStores(async (cryptoStoreType) => {
                const { client, http } = createTestClient(null, userId, cryptoStoreType);
                await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

                bindNullEngine(http);
                await Promise.all([
                    client.crypto.prepare([]),
                    http.flushAllExpected(),
                ]);

                const mockEvent = {
                    raw: {
                        type: "m.room.encrypted",
                        room_id: "!room:example.org",
                        content: {
                            algorithm: "m.megolm.v1.aes-sha2",
                            session_id: "test_session",
                        },
                    },
                    megolmProperties: {
                        session_id: "test_session",
                    },
                };

                // No backup manager configured
                (client.crypto as any).backupManager = null;

                // Mock doDecryptRoomEvent to fail
                (client.crypto as any).doDecryptRoomEvent = simple.stub().callFn(() => {
                    throw new Error("MegolmDecryptionError: Unable to decrypt message");
                });

                try {
                    await client.crypto.decryptRoomEvent(mockEvent as any, "!room:example.org");
                    throw new Error("Should have thrown");
                } catch (e) {
                    expect(e.message).toContain("MegolmDecryptionError");
                }
            }));

            it('should throw original error when backup recovery fails', () => testCryptoStores(async (cryptoStoreType) => {
                const { client, http } = createTestClient(null, userId, cryptoStoreType);
                await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

                bindNullEngine(http);
                await Promise.all([
                    client.crypto.prepare([]),
                    http.flushAllExpected(),
                ]);

                const mockEvent = {
                    raw: {
                        type: "m.room.encrypted",
                        room_id: "!room:example.org",
                        content: {
                            algorithm: "m.megolm.v1.aes-sha2",
                            session_id: "test_session",
                        },
                    },
                    megolmProperties: {
                        session_id: "test_session",
                    },
                };

                // Mock backup manager that fails to recover
                const mockBackupManager = {
                    importSessionKeyFromBackup: simple.stub().rejectWith(new Error("Network error")),
                };
                (client.crypto as any).backupManager = mockBackupManager;

                // Mock doDecryptRoomEvent to fail
                (client.crypto as any).doDecryptRoomEvent = simple.stub().callFn(() => {
                    throw new Error("MegolmDecryptionError: Unable to decrypt message");
                });

                try {
                    await client.crypto.decryptRoomEvent(mockEvent as any, "!room:example.org");
                    throw new Error("Should have thrown");
                } catch (e) {
                    // Should throw original decryption error, not backup error
                    expect(e.message).toContain("MegolmDecryptionError");
                }
            }));

            it('should not attempt recovery for non-missing-key errors', () => testCryptoStores(async (cryptoStoreType) => {
                const { client, http } = createTestClient(null, userId, cryptoStoreType);
                await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

                bindNullEngine(http);
                await Promise.all([
                    client.crypto.prepare([]),
                    http.flushAllExpected(),
                ]);

                const mockEvent = {
                    raw: {
                        type: "m.room.encrypted",
                        room_id: "!room:example.org",
                        content: {
                            algorithm: "m.megolm.v1.aes-sha2",
                            session_id: "test_session",
                        },
                    },
                    megolmProperties: {
                        session_id: "test_session",
                    },
                };

                // Mock backup manager
                const mockBackupManager = {
                    importSessionKeyFromBackup: simple.stub().resolveWith(true),
                };
                (client.crypto as any).backupManager = mockBackupManager;

                // Mock doDecryptRoomEvent to fail with a different error
                (client.crypto as any).doDecryptRoomEvent = simple.stub().callFn(() => {
                    throw new Error("Some other error");
                });

                try {
                    await client.crypto.decryptRoomEvent(mockEvent as any, "!room:example.org");
                    throw new Error("Should have thrown");
                } catch (e) {
                    // Should NOT attempt backup recovery for non-missing-key errors
                    expect(mockBackupManager.importSessionKeyFromBackup.callCount).toBe(0);
                    expect(e.message).toBe("Some other error");
                }
            }));
        });
    });

    describe('encryptMedia', () => {
        const userId = "@alice:example.org";
        let client: MatrixClient;
        let http: HttpBackend;

        beforeEach(() => testCryptoStores(async (cryptoStoreType) => {
            const { client: mclient, http: mhttp } = createTestClient(null, userId, cryptoStoreType);
            client = mclient;
            http = mhttp;

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

            // client crypto not prepared for the one test which wants that state
        }));

        it('should fail when the crypto has not been prepared', async () => {
            try {
                await client.crypto.encryptMedia(null);

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption has not initialized");
            }
        });

        it('should encrypt media', async () => {
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            const inputBuffer = Buffer.from("test");
            const inputStr = inputBuffer.join('');

            const result = await client.crypto.encryptMedia(inputBuffer);
            expect(result).toBeDefined();
            expect(result.buffer).toBeDefined();
            expect(result.buffer.join('')).not.toEqual(inputStr);
            expect(result.file).toBeDefined();
            expect(result.file.hashes).toBeDefined();
            expect(result.file.hashes.sha256).not.toEqual("n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg");
            expect(result.file).toMatchObject({
                hashes: {
                    sha256: expect.any(String),
                },
                key: {
                    alg: "A256CTR",
                    ext: true,
                    key_ops: expect.arrayContaining(['encrypt', 'decrypt']),
                    kty: "oct",
                    k: expect.any(String),
                },
                iv: expect.any(String),
                v: "v2",
            });
        });
    });

    describe('shareRoomHistoryWithUser', () => {
        const userId = "@alice:example.org";
        const roomId = "!room:example.org";
        const targetUserId = "@bob:example.org";
        let client: MatrixClient;
        let http: HttpBackend;

        beforeEach(() => testCryptoStores(async (cryptoStoreType) => {
            const { client: mclient, http: mhttp } = createTestClient(null, userId, cryptoStoreType);
            client = mclient;
            http = mhttp;

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);
        }));

        it('should no-op for unencrypted rooms', async () => {
            (<any>client.crypto).roomTracker.getRoomCryptoConfig = () => Promise.resolve({});
            const buildSpy = simple.mock((<any>client.crypto).engine.machine, "buildRoomKeyBundle");

            await client.crypto.shareRoomHistoryWithUser(roomId, targetUserId);

            expect(buildSpy.callCount).toBe(0);
        });

        it('should not share when the history visibility disallows it', async () => {
            (<any>client.crypto).roomTracker.getRoomCryptoConfig = () => Promise.resolve({ algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 });
            client.getRoomStateEvent = () => Promise.resolve({ history_visibility: "joined" });
            const buildSpy = simple.mock((<any>client.crypto).engine.machine, "buildRoomKeyBundle");

            await client.crypto.shareRoomHistoryWithUser(roomId, targetUserId);

            expect(buildSpy.callCount).toBe(0);
        });

        it('should bootstrap cross-signing and stop quietly when there are no shareable keys', async () => {
            (<any>client.crypto).roomTracker.getRoomCryptoConfig = () => Promise.resolve({ algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 });
            client.getRoomStateEvent = () => Promise.resolve({ history_visibility: "shared" });
            const bootstrapSpy = simple.mock(client.crypto, "ensureCrossSigningBootstrapped").callFn(() => Promise.resolve());
            const uploadSpy = simple.mock(client, "uploadContent");

            await client.crypto.shareRoomHistoryWithUser(roomId, targetUserId);

            expect(bootstrapSpy.callCount).toBe(1);
            expect(uploadSpy.callCount).toBe(0);
        });
    });

    describe('room key bundle acceptance (MSC4268)', () => {
        const userId = "@alice:example.org";
        const roomId = "!room:example.org";
        const inviter = "@inviter:example.org";
        let client: MatrixClient;
        let http: HttpBackend;

        beforeEach(() => testCryptoStores(async (cryptoStoreType) => {
            const { client: mclient, http: mhttp } = createTestClient(null, userId, cryptoStoreType);
            client = mclient;
            http = mhttp;

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);
        }));

        it('maybeAcceptKeyBundle returns false and keeps waiting when no bundle was received', async () => {
            (<any>client.crypto).engine.forceKeysQueryForUsers = () => Promise.resolve();

            await client.crypto.markRoomAsPendingKeyBundle(roomId, inviter);
            const accepted = await client.crypto.maybeAcceptKeyBundle(roomId, inviter);

            expect(accepted).toBe(false);
            // The pending record must survive so a late-arriving bundle can still be imported.
            const machine = (<any>client.crypto).engine.machine;
            const details = await machine.getPendingKeyBundleDetailsForRoom(new RoomId(roomId));
            expect(details).not.toBeNull();
            expect(details.inviter).toEqual(inviter);
        });

        it('cross-signing identity round-trips through Secret Storage', async () => {
            const recoveryKey = "test recovery passphrase";
            const accountData = new Map<string, any>();
            let signingKeysBody: any = null;

            const wireClient = (c: MatrixClient) => {
                (<any>c.crypto).config = { recoveryKey };
                c.getAccountData = <T>(eventType: string): Promise<T> => {
                    if (!accountData.has(eventType)) return Promise.reject(new Error("M_NOT_FOUND"));
                    return Promise.resolve(accountData.get(eventType));
                };
                c.setAccountData = (eventType: string, content: any) => {
                    accountData.set(eventType, content);
                    return Promise.resolve({});
                };
                (<any>c.crypto).engine.processCrossSigningBootstrapRequests = simple.stub().callFn((reqs) => {
                    signingKeysBody = JSON.parse(reqs.uploadSigningKeysReq);
                    return Promise.resolve();
                });
                (<any>c.crypto).engine.uploadSignatures = simple.stub().callFn(() => Promise.resolve());
            };

            // First boot: no identity anywhere -> bootstrap + persist to Secret Storage.
            wireClient(client);
            const bootstrapSpy = (<any>client.crypto).engine.processCrossSigningBootstrapRequests;
            await client.crypto.ensureCrossSigningBootstrapped();

            expect(bootstrapSpy.callCount).toBe(1);
            expect(signingKeysBody).not.toBeNull();
            expect(accountData.has("m.secret_storage.default_key")).toBe(true);
            expect(accountData.has("m.cross_signing.master")).toBe(true);
            expect(accountData.has("m.cross_signing.user_signing")).toBe(true);
            expect(accountData.has("m.cross_signing.self_signing")).toBe(true);

            const statusAfterBootstrap = await (<any>client.crypto).engine.machine.crossSigningStatus();
            expect(statusAfterBootstrap.hasMaster).toBe(true);

            // Second boot: fresh crypto store (new device) with the same account data
            // -> identity restored from Secret Storage, no new bootstrap. The restore
            // path forces a /keys/query for ourselves to learn our public identity.
            await testCryptoStores(async (cryptoStoreType) => {
                const { client: client2, http: http2 } = createTestClient(null, userId, cryptoStoreType);
                await client2.cryptoStore.setDeviceId("SECONDDEVICE");
                bindNullEngine(http2);
                await Promise.all([
                    client2.crypto.prepare([]),
                    http2.flushAllExpected(),
                ]);

                wireClient(client2);
                const bootstrapSpy2 = (<any>client2.crypto).engine.processCrossSigningBootstrapRequests;
                const signatureSpy2 = (<any>client2.crypto).engine.uploadSignatures;

                // The forced self keys-query must return our published public identity.
                http2.when("POST", "/keys/query").respond(200, () => {
                    return {
                        device_keys: {},
                        failures: {},
                        master_keys: { [userId]: signingKeysBody.master_key },
                        self_signing_keys: { [userId]: signingKeysBody.self_signing_key },
                        user_signing_keys: { [userId]: signingKeysBody.user_signing_key },
                    };
                });

                await Promise.all([
                    client2.crypto.ensureCrossSigningBootstrapped(),
                    http2.flushAllExpected(),
                ]);

                expect(bootstrapSpy2.callCount).toBe(0);
                expect(signatureSpy2.callCount).toBe(1);
                const status2 = await (<any>client2.crypto).engine.machine.crossSigningStatus();
                expect(status2.hasMaster).toBe(true);
                expect(status2.hasSelfSigning).toBe(true);
                expect(status2.hasUserSigning).toBe(true);
            });
        });
    });

    describe('decryptMedia', () => {
        const userId = "@alice:example.org";
        let client: MatrixClient;
        let http: HttpBackend;

        // Created from Element Web
        const testFileContents = "THIS IS A TEST FILE.";
        const mediaFileContents = Buffer.from("eB15hJlkw8WwgYxwY2mu8vS250s=", "base64");
        const testFile: EncryptedFile = {
            v: "v2",
            key: {
                alg: "A256CTR",
                ext: true,
                k: "l3OtQ3IJzfJa85j2WMsqNu7J--C-I1hzPxFvinR48mM",
                key_ops: [
                    "encrypt",
                    "decrypt",
                ],
                kty: "oct",
            },
            iv: "KJQOebQS1wwAAAAAAAAAAA",
            hashes: {
                sha256: "Qe4YzmVoPaEcLQeZwFZ4iMp/dlgeFph6mi5DmCaCOzg",
            },
            url: "mxc://localhost/uiWuISEVWixompuiiYyUoGrx",
        };

        function copyOfTestFile(): EncryptedFile {
            return JSON.parse(JSON.stringify(testFile));
        }

        beforeEach(() => testCryptoStores(async (cryptoStoreType) => {
            const { client: mclient, http: mhttp } = createTestClient(null, userId, cryptoStoreType);
            client = mclient;
            http = mhttp;

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);

            // client crypto not prepared for the one test which wants that state
        }));

        it('should fail when the crypto has not been prepared', async () => {
            try {
                await client.crypto.encryptMedia(null);

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption has not initialized");
            }
        });

        it('should be symmetrical', async () => {
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            const mxc = "mxc://example.org/test";
            const inputBuffer = Buffer.from("test");
            const encrypted = await client.crypto.encryptMedia(inputBuffer);

            const downloadSpy = simple.stub().callFn(async (u) => {
                expect(u).toEqual(mxc);
                return { data: encrypted.buffer, contentType: "application/octet-stream" };
            });
            client.downloadContent = downloadSpy;

            const result = await client.crypto.decryptMedia({
                url: mxc,
                ...encrypted.file,
            });
            expect(result.join('')).toEqual(inputBuffer.join(''));
            expect(downloadSpy.callCount).toBe(1);
        });

        it('should decrypt', async () => {
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            const downloadSpy = simple.stub().callFn(async (u) => {
                expect(u).toEqual(testFile.url);
                return { data: Buffer.from(mediaFileContents), contentType: "application/octet-stream" };
            });
            client.downloadContent = downloadSpy;

            const f = copyOfTestFile();
            const result = await client.crypto.decryptMedia(f);
            expect(result.toString()).toEqual(testFileContents);
            expect(downloadSpy.callCount).toBe(1);
        });
    });

    describe('User Tracking', () => {
        const userId = "@alice:example.org";
        let client: MatrixClient;
        let http: HttpBackend;

        beforeEach(() => testCryptoStores(async (cryptoStoreType) => {
            const { client: mclient, http: mhttp } = createTestClient(null, userId, cryptoStoreType);
            client = mclient;
            http = mhttp;

            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);
        }));

        it('should update tracked users on membership changes', async () => {
            const targetUserIds = ["@bob:example.org", "@charlie:example.org"];
            const prom = new Promise<void>(extResolve => {
                const trackSpy = simple.mock().callFn((uids) => {
                    expect(uids.length).toBe(1);
                    expect(uids[0]).toEqual(targetUserIds[trackSpy.callCount - 1]);
                    if (trackSpy.callCount === 2) extResolve();
                    return Promise.resolve();
                });
                (client.crypto as any).engine.addTrackedUsers = trackSpy;
            });

            for (const targetUserId of targetUserIds) {
                client.emit("room.event", "!unused:example.org", {
                    type: "m.room.member",
                    state_key: targetUserId,
                    content: { membership: "join" },
                    sender: targetUserId + ".notthisuser",
                });
            }

            // Emit a fake update too, to try and trip up the processing
            client.emit("room.event", "!unused:example.org", {
                type: "m.room.member",
                state_key: "@notjoined:example.org",
                content: { membership: "ban" },
                sender: "@notme:example.org",
            });

            // We do weird promise things because `emit()` is sync and we're using async code, so it can
            // end up not running fast enough for our callCount checks.
            await prom;
        });

        it('should add all tracked users when the encryption config changes', async () => {
            // Stub the room tracker
            (client.crypto as any).roomTracker.onRoomEvent = () => {};

            const targetUserIds = ["@bob:example.org", "@charlie:example.org"];
            const prom1 = new Promise<void>(extResolve => {
                (client.crypto as any).engine.addTrackedUsers = simple.mock().callFn((uids) => {
                    expect(uids).toEqual(targetUserIds);
                    extResolve();
                    return Promise.resolve();
                });
            });

            const roomId = "!room:example.org";
            const prom2 = new Promise<void>(extResolve => {
                client.getRoomMembers = simple.mock().callFn((rid, token, memberships) => {
                    expect(rid).toEqual(roomId);
                    expect(token).toBeFalsy();
                    expect(memberships).toEqual(["join", "invite"]);
                    extResolve();
                    return Promise.resolve(targetUserIds.map(u => new MembershipEvent({
                        type: "m.room.member",
                        state_key: u,
                        content: { membership: "join" },
                        sender: u,
                    })));
                });
            });

            client.emit("room.event", roomId, {
                type: "m.room.encryption",
                state_key: "",
                content: {
                    algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2,
                },
            });

            // We do weird promise things because `emit()` is sync and we're using async code, so it can
            // end up not running fast enough for our callCount checks.
            await Promise.all([prom1, prom2]);
        });

        it('should update the tracked users when joining a new room', async () => {
            // Stub the room tracker
            (client.crypto as any).roomTracker.onRoomJoin = () => {};

            const targetUserIds = ["@bob:example.org", "@charlie:example.org"];
            const prom1 = new Promise<void>(extResolve => {
                (client.crypto as any).engine.addTrackedUsers = simple.mock().callFn((uids) => {
                    expect(uids).toEqual(targetUserIds);
                    extResolve();
                    return Promise.resolve();
                });
            });

            const roomId = "!room:example.org";
            const prom2 = new Promise<void>(extResolve => {
                client.getRoomMembers = simple.mock().callFn((rid, token, memberships) => {
                    expect(rid).toEqual(roomId);
                    expect(token).toBeFalsy();
                    expect(memberships).toEqual(["join", "invite"]);
                    extResolve();
                    return Promise.resolve(targetUserIds.map(u => new MembershipEvent({
                        type: "m.room.member",
                        state_key: u,
                        content: { membership: "join" },
                        sender: u,
                    })));
                });
            });

            client.crypto.isRoomEncrypted = async (rid) => {
                expect(rid).toEqual(roomId);
                return true;
            };
            client.emit("room.join", roomId);

            // We do weird promise things because `emit()` is sync and we're using async code, so it can
            // end up not running fast enough for our callCount checks.
            await Promise.all([prom1, prom2]);
        });
    });
});
