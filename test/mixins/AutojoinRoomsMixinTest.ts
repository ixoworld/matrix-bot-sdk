import * as simple from "simple-mock";

import { Appservice, AutojoinRoomsMixin, Intent } from "../../src";
import { createTestClient } from "../TestUtils";
import { MemoryStorageProvider } from "../../src/storage/MemoryStorageProvider";

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

const BOT_USER_ID = "@bot:example.org";

function makeSyncResponse(inviteRoomIds: string[], nextBatch = "next_token") {
    const invite: Record<string, any> = {};
    for (const roomId of inviteRoomIds) {
        invite[roomId] = {
            invite_state: {
                events: [
                    {
                        type: "m.room.member",
                        state_key: BOT_USER_ID,
                        content: { membership: "invite" },
                        sender: "@someone:example.org",
                        unsigned: { age: 1000 },
                    },
                ],
            },
        };
    }
    return { rooms: { invite }, next_batch: nextBatch };
}

describe('AutojoinRoomsMixin', () => {
    afterEach(() => {
        simple.restore();
    });

    // --- Invite event handler tests ---

    it('should join rooms for regular invites', async () => {
        const { client } = createTestClient();

        const roomId = "!test:example.org";

        const joinSpy = simple.mock(client, "joinRoom").callFn((rid) => {
            expect(rid).toEqual(roomId);
            return Promise.resolve(roomId);
        });

        AutojoinRoomsMixin.setupOnClient(client);
        client.emit("room.invite", roomId, {});
        await tick();
        expect(joinSpy.callCount).toBe(1);
        AutojoinRoomsMixin.stopSweep(client);
    });

    it('should retry joining on failure and succeed', async () => {
        const { client } = createTestClient();

        const roomId = "!retry:example.org";
        let callCount = 0;

        simple.mock(client, "joinRoom").callFn(() => {
            callCount++;
            if (callCount < 3) {
                return Promise.reject(new Error("rate limited"));
            }
            return Promise.resolve(roomId);
        });

        AutojoinRoomsMixin.setupOnClient(client);
        client.emit("room.invite", roomId, {});
        // Wait enough time for retries: 500ms + 1000ms + buffer
        await tick(2500);
        expect(callCount).toBe(3);
        AutojoinRoomsMixin.stopSweep(client);
    });

    it('should give up after max retry attempts', async () => {
        const { client } = createTestClient();

        const roomId = "!fail:example.org";
        let callCount = 0;

        simple.mock(client, "joinRoom").callFn(() => {
            callCount++;
            return Promise.reject(new Error("always fails"));
        });

        AutojoinRoomsMixin.setupOnClient(client);
        client.emit("room.invite", roomId, {});
        // Wait enough time for all retries: 500ms + 1000ms + 2000ms + buffer
        await tick(4500);
        expect(callCount).toBe(4); // 1 initial + 3 retries
        AutojoinRoomsMixin.stopSweep(client);
    });

    // --- Cleanup tests ---

    it('should stop sweep timers and remove listener', () => {
        const { client } = createTestClient();

        simple.mock(client, "joinRoom").returnWith(Promise.resolve("!r:e.org"));

        const baseListeners = client.listenerCount("room.invite");
        AutojoinRoomsMixin.setupOnClient(client);
        expect((client as any).__autojoinSweepInterval).toBeDefined();
        expect((client as any).__autojoinInviteListener).toBeDefined();
        expect(client.listenerCount("room.invite")).toBe(baseListeners + 1);

        AutojoinRoomsMixin.stopSweep(client);
        expect((client as any).__autojoinSweepInterval).toBeUndefined();
        expect((client as any).__autojoinSweepInitialTimeout).toBeUndefined();
        expect((client as any).__autojoinInviteListener).toBeUndefined();
        expect((client as any).__autojoinSweepRunning).toBeUndefined();
        expect(client.listenerCount("room.invite")).toBe(baseListeners);
    });

    it('should not leak listeners on duplicate setupOnClient calls', () => {
        const { client } = createTestClient();

        simple.mock(client, "joinRoom").returnWith(Promise.resolve("!r:e.org"));

        const baseListeners = client.listenerCount("room.invite");
        AutojoinRoomsMixin.setupOnClient(client);
        AutojoinRoomsMixin.setupOnClient(client);
        AutojoinRoomsMixin.setupOnClient(client);

        // Should only have 1 mixin listener despite 3 setup calls
        expect(client.listenerCount("room.invite")).toBe(baseListeners + 1);

        AutojoinRoomsMixin.stopSweep(client);
        expect(client.listenerCount("room.invite")).toBe(baseListeners);
    });

    // --- Sweep tests ---

    it('should sweep and join pending invites', async () => {
        const storage = new MemoryStorageProvider();
        const { client } = createTestClient(storage, BOT_USER_ID);

        const joinedRooms: string[] = [];
        simple.mock(client, "joinRoom").callFn((rid) => {
            joinedRooms.push(rid);
            return Promise.resolve(rid);
        });

        simple.mock(client, "getUserId").returnWith(Promise.resolve(BOT_USER_ID));

        const syncResponse = makeSyncResponse(["!room1:example.org", "!room2:example.org"]);
        simple.mock(client, "doRequest").callFn((method, endpoint) => {
            if (method === "POST" && endpoint.includes("/filter")) {
                return Promise.resolve({ filter_id: "f123" });
            }
            if (method === "GET" && endpoint.includes("/sync")) {
                return Promise.resolve(syncResponse);
            }
            return Promise.reject(new Error(`Unexpected request: ${method} ${endpoint}`));
        });

        AutojoinRoomsMixin.setupOnClient(client);
        // Manually trigger sweep instead of waiting for timer
        await (AutojoinRoomsMixin as any).performSweep(client);

        expect(joinedRooms).toContain("!room1:example.org");
        expect(joinedRooms).toContain("!room2:example.org");
        expect(joinedRooms.length).toBe(2);

        // Token should have advanced since all joins succeeded
        const savedToken = await storage.readValue("autojoin_sweep_sync_token");
        expect(savedToken).toBe("next_token");

        AutojoinRoomsMixin.stopSweep(client);
    });

    it('should not advance sweep token when a join fails', async () => {
        const storage = new MemoryStorageProvider();
        const { client } = createTestClient(storage, BOT_USER_ID);

        simple.mock(client, "getUserId").returnWith(Promise.resolve(BOT_USER_ID));

        simple.mock(client, "joinRoom").callFn((rid) => {
            if (rid === "!fail:example.org") {
                return Promise.reject(new Error("forbidden"));
            }
            return Promise.resolve(rid);
        });

        const syncResponse = makeSyncResponse(["!ok:example.org", "!fail:example.org"]);
        simple.mock(client, "doRequest").callFn((method, endpoint) => {
            if (method === "POST" && endpoint.includes("/filter")) {
                return Promise.resolve({ filter_id: "f123" });
            }
            if (method === "GET" && endpoint.includes("/sync")) {
                return Promise.resolve(syncResponse);
            }
            return Promise.reject(new Error(`Unexpected request: ${method} ${endpoint}`));
        });

        AutojoinRoomsMixin.setupOnClient(client);
        await (AutojoinRoomsMixin as any).performSweep(client);

        // Token should NOT have advanced because !fail:example.org failed
        const savedToken = await storage.readValue("autojoin_sweep_sync_token");
        expect(savedToken).toBeUndefined();

        AutojoinRoomsMixin.stopSweep(client);
    }, 20000);

    it('should advance sweep token when no invites exist', async () => {
        const storage = new MemoryStorageProvider();
        const { client } = createTestClient(storage, BOT_USER_ID);

        simple.mock(client, "getUserId").returnWith(Promise.resolve(BOT_USER_ID));

        simple.mock(client, "doRequest").callFn((method, endpoint) => {
            if (method === "POST" && endpoint.includes("/filter")) {
                return Promise.resolve({ filter_id: "f123" });
            }
            if (method === "GET" && endpoint.includes("/sync")) {
                return Promise.resolve({ rooms: { invite: {} }, next_batch: "empty_token" });
            }
            return Promise.reject(new Error(`Unexpected request: ${method} ${endpoint}`));
        });

        AutojoinRoomsMixin.setupOnClient(client);
        await (AutojoinRoomsMixin as any).performSweep(client);

        const savedToken = await storage.readValue("autojoin_sweep_sync_token");
        expect(savedToken).toBe("empty_token");

        AutojoinRoomsMixin.stopSweep(client);
    });

    it('should cache sweep filter ID in storage', async () => {
        const storage = new MemoryStorageProvider();
        const { client } = createTestClient(storage, BOT_USER_ID);

        simple.mock(client, "getUserId").returnWith(Promise.resolve(BOT_USER_ID));
        simple.mock(client, "joinRoom").returnWith(Promise.resolve("!r:e.org"));

        let filterCreateCount = 0;
        simple.mock(client, "doRequest").callFn((method, endpoint) => {
            if (method === "POST" && endpoint.includes("/filter")) {
                filterCreateCount++;
                return Promise.resolve({ filter_id: "cached_filter" });
            }
            if (method === "GET" && endpoint.includes("/sync")) {
                return Promise.resolve({ rooms: {}, next_batch: "t1" });
            }
            return Promise.reject(new Error(`Unexpected request: ${method} ${endpoint}`));
        });

        AutojoinRoomsMixin.setupOnClient(client);

        // Run sweep twice
        await (AutojoinRoomsMixin as any).performSweep(client);
        await (AutojoinRoomsMixin as any).performSweep(client);

        // Filter should only be created once
        expect(filterCreateCount).toBe(1);

        // Filter ID should be in storage
        const storedFilter = await storage.readValue("autojoin_sweep_filter_id");
        expect(storedFilter).toBe("cached_filter");

        AutojoinRoomsMixin.stopSweep(client);
    });

    it('should skip concurrent sweeps', async () => {
        const storage = new MemoryStorageProvider();
        const { client } = createTestClient(storage, BOT_USER_ID);

        simple.mock(client, "getUserId").returnWith(Promise.resolve(BOT_USER_ID));

        let syncCallCount = 0;
        simple.mock(client, "doRequest").callFn((method, endpoint) => {
            if (method === "POST" && endpoint.includes("/filter")) {
                return Promise.resolve({ filter_id: "f1" });
            }
            if (method === "GET" && endpoint.includes("/sync")) {
                syncCallCount++;
                // Simulate a slow sync
                return new Promise(resolve =>
                    setTimeout(() => resolve({ rooms: {}, next_batch: "t1" }), 200),
                );
            }
            return Promise.reject(new Error(`Unexpected request: ${method} ${endpoint}`));
        });

        AutojoinRoomsMixin.setupOnClient(client);

        // Start two sweeps concurrently
        const sweep1 = (AutojoinRoomsMixin as any).performSweep(client);
        const sweep2 = (AutojoinRoomsMixin as any).performSweep(client);
        await Promise.all([sweep1, sweep2]);

        // Only one sync call should have been made
        expect(syncCallCount).toBe(1);

        AutojoinRoomsMixin.stopSweep(client);
    });

    // --- Appservice tests ---

    it('should join rooms for appservice invites', async () => {
        const appservice = new Appservice({
            port: 0,
            bindAddress: '127.0.0.1',
            homeserverName: 'example.org',
            homeserverUrl: 'https://localhost',
            registration: {
                as_token: "",
                hs_token: "",
                sender_localpart: "_bot_",
                namespaces: {
                    users: [{ exclusive: true, regex: "@_prefix_.*:.+" }],
                    rooms: [],
                    aliases: [],
                },
            },
        });
        appservice.botIntent.ensureRegistered = () => {
            return null;
        };

        const roomId = "!test:example.org";
        const userId = "@join:example.org";
        const event = { type: "m.room.test", state_key: userId };

        const joinSpy = simple.stub().callFn((rid) => {
            expect(rid).toEqual(roomId);
            return Promise.resolve(roomId);
        });

        appservice.getIntentForUserId = (uid) => {
            expect(uid).toEqual(userId);
            return {
                joinRoom: joinSpy,
            } as unknown as Intent;
        };

        AutojoinRoomsMixin.setupOnAppservice(appservice);
        appservice.emit("room.invite", roomId, event);
        await tick();
        expect(joinSpy.callCount).toBe(1);
    });

    it('should join rooms for appservice invites with conditions', async () => {
        const appservice = new Appservice({
            port: 0,
            bindAddress: '127.0.0.1',
            homeserverName: 'example.org',
            homeserverUrl: 'https://localhost',
            registration: {
                as_token: "",
                hs_token: "",
                sender_localpart: "_bot_",
                namespaces: {
                    users: [{ exclusive: true, regex: "@_prefix_.*:.+" }],
                    rooms: [],
                    aliases: [],
                },
            },
        });
        appservice.botIntent.ensureRegistered = () => {
            return null;
        };

        const notBotUserId = "@NOT_BOT:example.org";

        const okRoomId = "!ok:example.org";
        const okUserId = "@ok:example.org";
        const okEvent = { type: "m.room.ok", state_key: okUserId, sender: notBotUserId };

        const badRoomId = "!bad:example.org";
        const badUserId = "@bad:example.org";
        const badEvent = { type: "m.room.bad", state_key: badUserId, sender: notBotUserId };

        const joinSpy = simple.stub().callFn((rid) => {
            expect(rid).toEqual(okRoomId);
            return Promise.resolve(okRoomId);
        });

        appservice.getIntentForUserId = (uid) => {
            expect(uid).toEqual(okUserId);
            return {
                joinRoom: joinSpy,
            } as unknown as Intent;
        };

        const conditional = simple.stub().callFn((ev) => {
            expect(ev).toBeDefined();
            if (ev['type'] === 'm.room.ok') {
                expect(ev).toMatchObject(okEvent);
                return true;
            } else if (ev['type'] === 'm.room.bad') {
                expect(ev).toMatchObject(badEvent);
                return false;
            } else {
                throw new Error("Unexpected event");
            }
        });

        AutojoinRoomsMixin.setupOnAppservice(appservice, conditional);
        appservice.emit("room.invite", okRoomId, okEvent);
        await tick();
        expect(joinSpy.callCount).toBe(1);
        expect(conditional.callCount).toBe(1);
        appservice.emit("room.invite", badRoomId, badEvent);
        await tick();
        expect(joinSpy.callCount).toBe(1);
        expect(conditional.callCount).toBe(2);
    });

    it('should join rooms from the bot without a conditional', async () => {
        const appservice = new Appservice({
            port: 0,
            bindAddress: '127.0.0.1',
            homeserverName: 'example.org',
            homeserverUrl: 'https://localhost',
            registration: {
                as_token: "",
                hs_token: "",
                sender_localpart: "_bot_",
                namespaces: {
                    users: [{ exclusive: true, regex: "@_prefix_.*:.+" }],
                    rooms: [],
                    aliases: [],
                },
            },
        });
        appservice.botIntent.ensureRegistered = () => {
            return null;
        };

        const botUserId = "@_bot_:example.org";

        const okRoomId = "!ok:example.org";
        const okUserId = "@ok:example.org";
        const okEvent = { type: "m.room.ok", state_key: okUserId, sender: botUserId };

        const badRoomId = "!bad:example.org";
        const badUserId = "@bad:example.org";
        const badEvent = { type: "m.room.bad", state_key: badUserId, sender: botUserId };

        const joinSpy = simple.stub().callFn((rid) => {
            if (rid !== okRoomId && rid !== badRoomId) throw new Error("Unexpected room ID");
            return Promise.resolve(rid);
        });

        appservice.getIntentForUserId = (uid) => {
            if (uid !== okUserId && uid !== badUserId) throw new Error("Unexpected user ID");
            return {
                joinRoom: joinSpy,
            } as unknown as Intent;
        };

        const conditional = simple.stub().callFn((ev) => {
            expect(ev).toBeDefined();
            if (ev['type'] === 'm.room.ok') {
                expect(ev).toMatchObject(okEvent);
                return true;
            } else if (ev['type'] === 'm.room.bad') {
                expect(ev).toMatchObject(badEvent);
                return false;
            } else {
                throw new Error("Unexpected event");
            }
        });

        AutojoinRoomsMixin.setupOnAppservice(appservice, conditional);
        appservice.emit("room.invite", okRoomId, okEvent);
        await tick();
        expect(joinSpy.callCount).toBe(1);
        expect(conditional.callCount).toBe(0);
        appservice.emit("room.invite", badRoomId, badEvent);
        await tick();
        expect(joinSpy.callCount).toBe(2);
        expect(conditional.callCount).toBe(0);
    });
});
