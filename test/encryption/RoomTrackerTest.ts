import * as simple from "simple-mock";

import {
    EncryptionEventContent,
    ICryptoRoomInformation,
    MatrixClient,
    MatrixError,
    RoomEncryptionAlgorithm,
    RoomTracker,
} from "../../src";
import { createTestClient, testCryptoStores, TEST_DEVICE_ID } from "../TestUtils";
import { bindNullEngine } from "./CryptoClientTest";

function prepareQueueSpies(
    client: MatrixClient,
    roomId: string,
    content: Partial<EncryptionEventContent> = {}, storedContent: Partial<EncryptionEventContent> = null,
): simple.Stub<any>[] {
    const readSpy = simple.stub().callFn<any>((rid: string) => {
        expect(rid).toEqual(roomId);
        return Promise.resolve(storedContent);
    });

    const stateSpy = simple.stub().callFn((rid: string, eventType: string, stateKey: string) => {
        expect(rid).toEqual(roomId);
        expect(eventType).toEqual("m.room.encryption");
        expect(stateKey).toEqual("");
        return Promise.resolve(content);
    });

    const storeSpy = simple.stub().callFn((rid: string, c: Partial<EncryptionEventContent>) => {
        expect(rid).toEqual(roomId);
        expect(c).toMatchObject({
            ...content,
            algorithm: content['algorithm'] ?? 'UNKNOWN',
        });
        return Promise.resolve();
    });

    client.cryptoStore.getRoom = readSpy;
    client.cryptoStore.storeRoom = storeSpy;
    client.getRoomStateEvent = stateSpy;

    return [readSpy, stateSpy, storeSpy];
}

describe('RoomTracker', () => {
    it('should queue room updates when rooms are joined', () => testCryptoStores(async (cryptoStoreType) => {
        const roomId = "!a:example.org";

        const { client, http } = createTestClient(null, "@user:example.org", cryptoStoreType);
        await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
        bindNullEngine(http);
        await Promise.all([
            client.crypto.prepare([]),
            http.flushAllExpected(),
        ]);
        (client.crypto as any).engine.addTrackedUsers = () => Promise.resolve();
        client.getRoomMembers = () => Promise.resolve([]);

        const tracker = (client.crypto as any).roomTracker;

        let queueSpy: simple.Stub<any>;
        await new Promise<void>(resolve => {
            queueSpy = simple.stub().callFn((rid: string) => {
                expect(rid).toEqual(roomId);
                resolve();
                return Promise.resolve();
            });
            tracker.queueRoomCheck = queueSpy;
            client.emit("room.join", roomId);
        });
        expect(queueSpy.callCount).toEqual(1);
    }));

    it('should queue room updates when encryption events are received', () => testCryptoStores(async (cryptoStoreType) => {
        const roomId = "!a:example.org";

        const { client, http } = createTestClient(null, "@user:example.org", cryptoStoreType);
        await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
        bindNullEngine(http);
        await Promise.all([
            client.crypto.prepare([]),
            http.flushAllExpected(),
        ]);

        const tracker = (client.crypto as any).roomTracker;

        let queueSpy: simple.Stub<any>;
        await new Promise<void>(resolve => {
            queueSpy = simple.stub().callFn((rid: string) => {
                expect(rid).toEqual(roomId);
                resolve();
                return Promise.resolve();
            });
            tracker.queueRoomCheck = queueSpy;
            client.emit("room.event", roomId, {
                type: "not-m.room.encryption",
                state_key: "",
            });
            client.emit("room.event", roomId, {
                type: "m.room.encryption",
                state_key: "2",
            });
            client.emit("room.event", roomId, {
                type: "m.room.encryption",
                state_key: "",
            });
        });
        await new Promise<void>(resolve => setTimeout(() => resolve(), 250));
        expect(queueSpy.callCount).toEqual(1);
    }));

    it('should force a re-check when the room is joined', async () => {
        const roomId = "!a:example.org";
        const { client } = createTestClient();

        const queueSpy = simple.stub().callFn((rid: string, force: boolean) => {
            expect(rid).toEqual(roomId);
            expect(force).toEqual(true);
            return Promise.resolve();
        });

        const tracker = new RoomTracker(client);
        tracker.queueRoomCheck = queueSpy;
        await tracker.onRoomJoin(roomId);
        expect(queueSpy.callCount).toEqual(1);
    });

    it('should force a re-check on encryption and history visibility events', async () => {
        const roomId = "!a:example.org";
        const { client } = createTestClient();

        const queueSpy = simple.stub().callFn((rid: string, force: boolean) => {
            expect(rid).toEqual(roomId);
            expect(force).toEqual(true);
            return Promise.resolve();
        });

        const tracker = new RoomTracker(client);
        tracker.queueRoomCheck = queueSpy;
        await tracker.onRoomEvent(roomId, { type: "m.room.encryption", state_key: "" });
        await tracker.onRoomEvent(roomId, { type: "m.room.history_visibility", state_key: "" });
        await tracker.onRoomEvent(roomId, { type: "m.room.topic", state_key: "" }); // ignored
        expect(queueSpy.callCount).toEqual(2);
    });

    describe('prepare', () => {
        function stubCryptoStore(client: MatrixClient, stored: Record<string, ICryptoRoomInformation>, withBatch = true) {
            const storeRoomSpy = simple.stub().callFn((rid: string, config: ICryptoRoomInformation) => {
                stored[rid] = config;
                return Promise.resolve();
            });
            const storeRoomsSpy = simple.stub().callFn((configs: Record<string, ICryptoRoomInformation>) => {
                Object.assign(stored, configs);
                return Promise.resolve();
            });
            (client as any).cryptoStore = {
                getRoom: (rid: string) => Promise.resolve(stored[rid] ?? null),
                storeRoom: storeRoomSpy,
                ...(withBatch ? { storeRooms: storeRoomsSpy } : {}),
            };
            return { storeRoomSpy, storeRoomsSpy };
        }

        function stubEncryptedStateFor(client: MatrixClient, encryptedRooms: string[]) {
            client.getRoomStateEvent = async (rid: string, eventType: string) => {
                if (encryptedRooms.includes(rid) && eventType === "m.room.encryption") {
                    return { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 };
                }
                if (encryptedRooms.includes(rid) && eventType === "m.room.history_visibility") {
                    return { history_visibility: "shared" };
                }
                throw new MatrixError({ errcode: "M_NOT_FOUND", error: "Event not found." }, 404);
            };
        }

        it('should check unknown rooms and batch-store only the encrypted ones', async () => {
            const encryptedRoom = "!enc:example.org";
            const unencryptedRoom = "!plain:example.org";

            const { client } = createTestClient();
            const stored: Record<string, ICryptoRoomInformation> = {};
            const { storeRoomSpy, storeRoomsSpy } = stubCryptoStore(client, stored);
            stubEncryptedStateFor(client, [encryptedRoom]);

            const tracker = new RoomTracker(client);
            await tracker.prepare([encryptedRoom, unencryptedRoom]);

            expect(storeRoomsSpy.callCount).toEqual(1); // one batch write, not per-room
            expect(storeRoomSpy.callCount).toEqual(0);
            expect(stored[encryptedRoom]).toMatchObject({
                algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2,
                historyVisibility: "shared",
            });
            // Unencrypted rooms are deliberately never stored: consumers ask
            // the server on use, so later encryption enablement is always seen.
            expect(stored[unencryptedRoom]).toBeUndefined();
        });

        it('should skip rooms already known to be encrypted', async () => {
            const encryptedRoom = "!enc:example.org";

            const { client } = createTestClient();
            const stored: Record<string, ICryptoRoomInformation> = {
                [encryptedRoom]: { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 },
            };
            const { storeRoomsSpy } = stubCryptoStore(client, stored);

            const stateSpy = simple.stub().callFn(() => Promise.resolve({}));
            client.getRoomStateEvent = stateSpy;

            const tracker = new RoomTracker(client);
            await tracker.prepare([encryptedRoom]);

            expect(stateSpy.callCount).toEqual(0); // nothing was fetched
            expect(storeRoomsSpy.callCount).toEqual(0); // nothing was written
        });

        it('should not let one failing room abort the rest', async () => {
            const failingRoom = "!fail:example.org";
            const encryptedRoom = "!enc:example.org";

            const { client } = createTestClient();
            const stored: Record<string, ICryptoRoomInformation> = {};
            stubCryptoStore(client, stored);

            client.getRoomStateEvent = async (rid: string, eventType: string) => {
                if (rid === failingRoom) throw new Error("Simulated network failure");
                if (eventType === "m.room.encryption") return { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 };
                return { history_visibility: "shared" };
            };

            const tracker = new RoomTracker(client);
            await tracker.prepare([failingRoom, encryptedRoom]);

            expect(stored[failingRoom]).toBeUndefined(); // transient failure: nothing cached
            expect(stored[encryptedRoom]).toMatchObject({ algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 });
        });

        it('should fall back to per-room writes when the store has no batch support', async () => {
            const encryptedRoom = "!enc:example.org";

            const { client } = createTestClient();
            const stored: Record<string, ICryptoRoomInformation> = {};
            const { storeRoomSpy } = stubCryptoStore(client, stored, false);
            stubEncryptedStateFor(client, [encryptedRoom]);

            const tracker = new RoomTracker(client);
            await tracker.prepare([encryptedRoom]);

            expect(storeRoomSpy.callCount).toEqual(1);
            expect(stored[encryptedRoom]).toMatchObject({ algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 });
        });
    });

    describe('queueRoomCheck', () => {
        it('should store unknown rooms', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!b:example.org";
            const content = { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2, rid: "1" };

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            const [readSpy, stateSpy, storeSpy] = prepareQueueSpies(client, roomId, content);

            const tracker = new RoomTracker(client);
            await tracker.queueRoomCheck(roomId);
            expect(readSpy.callCount).toEqual(1);
            expect(stateSpy.callCount).toEqual(2); // m.room.encryption and m.room.history_visibility
            expect(storeSpy.callCount).toEqual(1);
        }));

        it('should skip known rooms', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!b:example.org";
            const content = { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2, rid: "1" };

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            const [readSpy, stateSpy, storeSpy] = prepareQueueSpies(client, roomId, { algorithm: "no" }, content);

            const tracker = new RoomTracker(client);
            await tracker.queueRoomCheck(roomId);
            expect(readSpy.callCount).toEqual(1);
            expect(stateSpy.callCount).toEqual(0);
            expect(storeSpy.callCount).toEqual(0);
        }));

        it('should not store anything on non-definitive errors', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!b:example.org";
            const content = { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2, rid: "1" };

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            const [readSpy, stateSpy, storeSpy] = prepareQueueSpies(client, roomId, content);
            client.getRoomStateEvent = async (rid: string, et: string, sk: string) => {
                await stateSpy(rid, et, sk);
                throw new Error("Simulated network failure");
            };

            const tracker = new RoomTracker(client);
            await tracker.queueRoomCheck(roomId);
            expect(readSpy.callCount).toEqual(1);
            expect(stateSpy.callCount).toEqual(1);
            expect(storeSpy.callCount).toEqual(0);
        }));

        it('should not store anything on rate limit or server errors', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!b:example.org";
            const content = { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2, rid: "1" };

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            const [readSpy, stateSpy, storeSpy] = prepareQueueSpies(client, roomId, content);
            client.getRoomStateEvent = async (rid: string, et: string, sk: string) => {
                await stateSpy(rid, et, sk);
                throw new MatrixError({ errcode: "M_LIMIT_EXCEEDED", error: "Too many requests" }, 429);
            };

            const tracker = new RoomTracker(client);
            await tracker.queueRoomCheck(roomId);
            expect(stateSpy.callCount).toEqual(1);
            expect(storeSpy.callCount).toEqual(0);

            client.getRoomStateEvent = async (rid: string, et: string, sk: string) => {
                await stateSpy(rid, et, sk);
                throw new MatrixError({ errcode: "M_UNKNOWN", error: "Internal error" }, 500);
            };
            await tracker.queueRoomCheck(roomId);
            expect(stateSpy.callCount).toEqual(2);
            expect(storeSpy.callCount).toEqual(0);
            expect(readSpy.callCount).toEqual(2);
        }));

        it('should not store unencrypted rooms', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!b:example.org";

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            const readSpy = simple.stub().callFn<any>(() => Promise.resolve(null));
            const stateSpy = simple.stub().callFn(() => {
                throw new MatrixError({ errcode: "M_NOT_FOUND", error: "Event not found." }, 404);
            });
            const storeSpy = simple.stub();
            client.cryptoStore.getRoom = readSpy;
            client.cryptoStore.storeRoom = storeSpy;
            client.getRoomStateEvent = stateSpy;

            const tracker = new RoomTracker(client);
            await tracker.queueRoomCheck(roomId);
            expect(stateSpy.callCount).toEqual(1);
            // Deliberately not cached: consumers ask the server on use, so a
            // room that enables encryption at any point is always seen.
            expect(storeSpy.callCount).toEqual(0);
        }));

        it('should refresh the stored config when forced', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!b:example.org";

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            // Encrypted room changes history visibility: force must refresh the
            // stored config (regression: this used to be frozen at first check).
            const stored: any[] = [{ algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2, historyVisibility: "joined" }];
            const storeSpy = simple.stub().callFn((rid: string, config: any) => {
                stored.push(config);
                return Promise.resolve();
            });
            client.cryptoStore.getRoom = simple.stub().callFn<any>(() => Promise.resolve(stored[stored.length - 1]));
            client.cryptoStore.storeRoom = storeSpy;
            client.getRoomStateEvent = async (rid: string, eventType: string) => {
                if (eventType === "m.room.encryption") return { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 };
                return { history_visibility: "shared" };
            };

            const tracker = new RoomTracker(client);

            // Without force: skipped (already known encrypted).
            await tracker.queueRoomCheck(roomId);
            expect(storeSpy.callCount).toEqual(0);

            await tracker.queueRoomCheck(roomId, true);
            expect(storeSpy.callCount).toEqual(1);
            expect(stored[stored.length - 1]).toMatchObject({
                algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2,
                historyVisibility: "shared",
            });
        }));

        it('should not clobber the stored config when a forced check fails', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!b:example.org";

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            const readSpy = simple.stub().callFn<any>(() => Promise.resolve(
                { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 },
            ));
            const storeSpy = simple.stub();
            client.cryptoStore.getRoom = readSpy;
            client.cryptoStore.storeRoom = storeSpy;
            client.getRoomStateEvent = async () => {
                throw new Error("Simulated network failure");
            };

            const tracker = new RoomTracker(client);
            await tracker.queueRoomCheck(roomId, true);
            expect(storeSpy.callCount).toEqual(0); // the known-good config stays
        }));
    });

    describe('getRoomCryptoConfig', () => {
        it('should return the config as-is', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!a:example.org";
            const content: Partial<EncryptionEventContent> = { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 };

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            const readSpy = simple.stub().callFn<any>((rid: string) => {
                expect(rid).toEqual(roomId);
                return Promise.resolve(content);
            });

            client.cryptoStore.getRoom = readSpy;

            const tracker = new RoomTracker(client);
            const config = await tracker.getRoomCryptoConfig(roomId);
            expect(readSpy.callCount).toEqual(1);
            expect(config).toMatchObject(content);
        }));

        it('should check and store unknown encrypted rooms', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!a:example.org";

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            const readSpy = simple.stub().callFn<any>(() => Promise.resolve(null));
            const storeSpy = simple.stub().callFn((rid: string, config: any) => {
                expect(rid).toEqual(roomId);
                expect(config).toMatchObject({ algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 });
                return Promise.resolve();
            });
            client.cryptoStore.getRoom = readSpy;
            client.cryptoStore.storeRoom = storeSpy;
            client.getRoomStateEvent = async (rid: string, eventType: string) => {
                if (eventType === "m.room.encryption") return { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 };
                return { history_visibility: "shared" };
            };

            const tracker = new RoomTracker(client);
            const config = await tracker.getRoomCryptoConfig(roomId);
            expect(storeSpy.callCount).toEqual(1);
            expect(config).toMatchObject({ algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 });
        }));

        it('should return empty for unencrypted rooms and not store them', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!a:example.org";

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            const readSpy = simple.stub().callFn<any>(() => Promise.resolve(null));
            const storeSpy = simple.stub();
            client.cryptoStore.getRoom = readSpy;
            client.cryptoStore.storeRoom = storeSpy;
            client.getRoomStateEvent = async () => {
                throw new MatrixError({ errcode: "M_NOT_FOUND", error: "Event not found." }, 404);
            };

            const tracker = new RoomTracker(client);
            const config = await tracker.getRoomCryptoConfig(roomId);
            expect(config).toEqual({});
            expect(storeSpy.callCount).toEqual(0);
        }));

        it('should treat transient failures as unknown by default', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!a:example.org";

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            client.cryptoStore.getRoom = simple.stub().callFn<any>(() => Promise.resolve(null));
            client.cryptoStore.storeRoom = simple.stub();
            client.getRoomStateEvent = async () => {
                throw new MatrixError({ errcode: "M_UNKNOWN", error: "Internal error" }, 500);
            };

            const tracker = new RoomTracker(client);
            // Lenient mode (decrypt paths): degrade gracefully.
            const config = await tracker.getRoomCryptoConfig(roomId);
            expect(config).toEqual({});
        }));

        it('should fail closed on transient failures when asked', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!a:example.org";

            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            client.cryptoStore.getRoom = simple.stub().callFn<any>(() => Promise.resolve(null));
            client.cryptoStore.storeRoom = simple.stub();
            client.getRoomStateEvent = async () => {
                throw new MatrixError({ errcode: "M_UNKNOWN", error: "Internal error" }, 500);
            };

            const tracker = new RoomTracker(client);
            // Strict mode (send path): guessing "not encrypted" would leak
            // plaintext into an encrypted room, so the caller must get an error.
            await expect(tracker.getRoomCryptoConfig(roomId, true)).rejects.toThrow();

            // A definitive 404 is not a failure: plaintext is correct then.
            client.getRoomStateEvent = async () => {
                throw new MatrixError({ errcode: "M_NOT_FOUND", error: "Event not found." }, 404);
            };
            expect(await tracker.getRoomCryptoConfig(roomId, true)).toEqual({});
        }));
    });

    describe('safety invariants', () => {
        it('isRoomEncrypted should flip when an encryption event arrives for a previously unencrypted room', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!flip:example.org";

            const { client, http } = createTestClient(null, "@user:example.org", cryptoStoreType);
            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);
            (client.crypto as any).engine.addTrackedUsers = () => Promise.resolve();
            client.getRoomMembers = () => Promise.resolve([]);

            // Unencrypted: every isRoomEncrypted asks the server fresh.
            client.getRoomStateEvent = async () => {
                throw new MatrixError({ errcode: "M_NOT_FOUND", error: "Event not found." }, 404);
            };
            expect(await client.crypto.isRoomEncrypted(roomId)).toBe(false);

            // The room turns encrypted and the client sees the state event.
            client.getRoomStateEvent = async (rid: string, eventType: string) => {
                if (eventType === "m.room.encryption") return { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 };
                return { history_visibility: "shared" };
            };
            await client.crypto.onRoomEvent(roomId, {
                type: "m.room.encryption",
                state_key: "",
                content: { algorithm: "m.megolm.v1.aes-sha2" },
            });

            expect(await client.crypto.isRoomEncrypted(roomId)).toBe(true);
        }));

        it('isRoomEncrypted should see encryption enabled while the client was offline, with no event at all', () => testCryptoStores(async (cryptoStoreType) => {
            const roomId = "!offline:example.org";

            const { client, http } = createTestClient(null, "@user:example.org", cryptoStoreType);
            await client.cryptoStore.setDeviceId(TEST_DEVICE_ID);
            bindNullEngine(http);
            await Promise.all([
                client.crypto.prepare([]),
                http.flushAllExpected(),
            ]);

            // No stored entry, no invalidation event ever processed: the lazy
            // check still asks the server and gets the fresh truth.
            client.getRoomStateEvent = async (rid: string, eventType: string) => {
                if (eventType === "m.room.encryption") return { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2 };
                return { history_visibility: "shared" };
            };
            expect(await client.crypto.isRoomEncrypted(roomId)).toBe(true);
        }));
    });

    describe('crypto store batch writes', () => {
        it('should persist a batch and read entries back individually', () => testCryptoStores(async (cryptoStoreType) => {
            const { client } = createTestClient(null, "@user:example.org", cryptoStoreType);

            expect(client.cryptoStore.storeRooms).toBeDefined();
            await client.cryptoStore.storeRooms({
                "!enc:example.org": { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2, historyVisibility: "shared" },
                "!enc2:example.org": { algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2, historyVisibility: "joined" },
            });

            expect(await client.cryptoStore.getRoom("!enc:example.org")).toMatchObject({
                algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2,
                historyVisibility: "shared",
            });
            expect(await client.cryptoStore.getRoom("!enc2:example.org")).toMatchObject({
                algorithm: RoomEncryptionAlgorithm.MegolmV1AesSha2,
                historyVisibility: "joined",
            });

            // Batch writes must survive a store reload (ie actually hit disk).
            const reloaded = new (client.cryptoStore.constructor as any)(
                (client.cryptoStore as any).storagePath,
                cryptoStoreType,
            );
            expect(await reloaded.getRoom("!enc2:example.org")).toMatchObject({ historyVisibility: "joined" });
        }));
    });
});
