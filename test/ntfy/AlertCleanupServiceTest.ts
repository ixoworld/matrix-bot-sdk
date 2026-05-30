import { ALERT_LEDGER_EVENT_TYPE, AlertCleanupService } from "../../src";
import { createTestClient } from "../TestUtils";

describe('AlertCleanupService', () => {
    const selfUserId = "@self:example.org";
    const roomId = "!alerts:example.org";

    function ledgerPath(): string {
        return `/user/${encodeURIComponent(selfUserId)}/rooms/${encodeURIComponent(roomId)}/account_data/${encodeURIComponent(ALERT_LEDGER_EVENT_TYPE)}`;
    }

    it('should reject a non-positive ttl', () => {
        const { client } = createTestClient(null, selfUserId);
        expect(() => new AlertCleanupService(client, roomId, { ttlMs: 0 })).toThrow();
        expect(() => new AlertCleanupService(client, roomId, { ttlMs: -5 })).toThrow();
    });

    it('should require an archive room in archive mode', () => {
        const { client } = createTestClient(null, selfUserId);
        expect(() => new AlertCleanupService(client, roomId, { ttlMs: 1000, mode: "archive" })).toThrow();
    });

    it('should append tracked alerts to the ledger', async () => {
        const { client, http } = createTestClient(null, selfUserId);
        const service = new AlertCleanupService(client, roomId, { ttlMs: 60000 });

        http.when("GET", ledgerPath()).respond(200, { alerts: [] });
        http.when("PUT", ledgerPath()).respond(200, (path, body) => {
            expect(body.alerts).toHaveLength(1);
            expect(body.alerts[0].eventId).toEqual("$evt1");
            expect(body.alerts[0].topic).toEqual("ops");
            return {};
        });

        const [, ] = await Promise.all([service.track("$evt1", 123, "ops"), http.flushAllExpected()]);
    });

    it('should redact expired alerts and keep fresh ones', async () => {
        const { client, http } = createTestClient(null, selfUserId);
        const service = new AlertCleanupService(client, roomId, { ttlMs: 10000 });

        const now = Date.now();
        const ledger = {
            alerts: [
                { eventId: "$old", ts: now - 60000, topic: "ops" },
                { eventId: "$fresh", ts: now, topic: "ops" },
            ],
        };

        http.when("GET", ledgerPath()).respond(200, ledger);

        let redacted = false;
        http.when("PUT", `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent("$old")}`).respond(200, () => {
            redacted = true;
            return { event_id: "$redaction" };
        });

        http.when("PUT", ledgerPath()).respond(200, (path, body) => {
            // Only the fresh alert should survive.
            expect(body.alerts).toHaveLength(1);
            expect(body.alerts[0].eventId).toEqual("$fresh");
            return {};
        });

        const [cleaned] = await Promise.all([service.sweep(), http.flushAllExpected()]);
        expect(redacted).toBe(true);
        expect(cleaned).toBe(1);
    });

    it('should treat an already-redacted alert as cleaned', async () => {
        const { client, http } = createTestClient(null, selfUserId);
        const service = new AlertCleanupService(client, roomId, { ttlMs: 10000 });

        const ledger = { alerts: [{ eventId: "$gone", ts: Date.now() - 60000 }] };
        http.when("GET", ledgerPath()).respond(200, ledger);
        http.when("PUT", `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent("$gone")}`).respond(404, {
            errcode: "M_NOT_FOUND",
            error: "Event not found",
        });
        http.when("PUT", ledgerPath()).respond(200, (path, body) => {
            expect(body.alerts).toHaveLength(0);
            return {};
        });

        const [cleaned] = await Promise.all([service.sweep(), http.flushAllExpected()]);
        expect(cleaned).toBe(1);
    });

    it('should archive then redact in archive mode', async () => {
        const { client, http } = createTestClient(null, selfUserId);
        const archiveRoomId = "!archive:example.org";
        const service = new AlertCleanupService(client, roomId, {
            ttlMs: 10000,
            mode: "archive",
            archiveRoomId,
        });

        const ledger = { alerts: [{ eventId: "$old", ts: Date.now() - 60000, topic: "ops" }] };
        http.when("GET", ledgerPath()).respond(200, ledger);
        http.when("GET", `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent("$old")}`).respond(200, {
            type: "m.room.message",
            content: { msgtype: "m.notice", body: "disk full" },
        });

        let archived = false;
        http.when("PUT", `/rooms/${encodeURIComponent(archiveRoomId)}/send/m.room.message/`).respond(200, (path, body) => {
            archived = true;
            expect(body.body).toEqual("disk full");
            expect((body["world.ixo.ntfy.archived"] as any).original_event_id).toEqual("$old");
            return { event_id: "$archived" };
        });
        http.when("PUT", `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent("$old")}`).respond(200, { event_id: "$redaction" });
        http.when("PUT", ledgerPath()).respond(200, { });

        const [cleaned] = await Promise.all([service.sweep(), http.flushAllExpected()]);
        expect(archived).toBe(true);
        expect(cleaned).toBe(1);
    });

    it('should do nothing when no alerts are expired', async () => {
        const { client, http } = createTestClient(null, selfUserId);
        const service = new AlertCleanupService(client, roomId, { ttlMs: 100000 });

        http.when("GET", ledgerPath()).respond(200, { alerts: [{ eventId: "$fresh", ts: Date.now() }] });

        const [cleaned] = await Promise.all([service.sweep(), http.flushAllExpected()]);
        expect(cleaned).toBe(0);
    });
});
