import * as simple from "simple-mock";

import {
    NTFY_ALERT_CONTENT_FLAG,
    NTFY_BRIDGE_EVENT_TYPE,
    NtfyClient,
    NtfyMatrixBridge,
    defaultFormatMessage,
} from "../../src";
import { createTestClient } from "../TestUtils";

describe('NtfyMatrixBridge', () => {
    const selfUserId = "@self:example.org";
    const roomId = "!alerts:example.org";

    beforeEach(() => {
        // Prevent the real ntfy subscriber from opening network connections during tests.
        simple.mock(NtfyClient.prototype, "start").callFn(() => { /* no-op */ });
        simple.mock(NtfyClient.prototype, "stop").callFn(() => { /* no-op */ });
    });

    afterEach(() => {
        simple.restore();
    });

    function bridgePath(): string {
        return `/user/${encodeURIComponent(selfUserId)}/account_data/${encodeURIComponent(NTFY_BRIDGE_EVENT_TYPE)}`;
    }

    it('should require at least one subscription', () => {
        const { client } = createTestClient(null, selfUserId);
        expect(() => new NtfyMatrixBridge(client, { ntfy: [] as any })).toThrow();
    });

    it('should forward a message into the configured room', async () => {
        const { client, http } = createTestClient(null, selfUserId);
        const bridge = new NtfyMatrixBridge(client, {
            ntfy: { topic: "alerts" },
            roomId,
            cleanup: false,
        });

        http.when("PUT", bridgePath()).respond(200, {});
        await Promise.all([bridge.start(), http.flushAllExpected()]);
        expect(bridge.serviceRoomId).toEqual(roomId);

        http.when("PUT", `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`).respond(200, (path, body) => {
            expect(body.msgtype).toEqual("m.notice");
            expect(body[NTFY_ALERT_CONTENT_FLAG]).toBe(true);
            expect(body.body).toContain("Disk space low");
            expect((body["world.ixo.ntfy.meta"] as any).topic).toEqual("alerts");
            return { event_id: "$posted" };
        });

        const [eventId] = await Promise.all([
            bridge.handleMessage({
                id: "abc",
                time: 1,
                event: "message",
                topic: "alerts",
                title: "Disk space low",
                message: "Only 2% left",
                priority: 4,
            }),
            http.flushAllExpected(),
        ]);
        expect(eventId).toEqual("$posted");
    });

    it('should drop messages below the priority threshold', async () => {
        const { client, http } = createTestClient(null, selfUserId);
        const bridge = new NtfyMatrixBridge(client, {
            ntfy: { topic: "alerts" },
            roomId,
            cleanup: false,
            priorityThreshold: 4,
        });

        http.when("PUT", bridgePath()).respond(200, {});
        await Promise.all([bridge.start(), http.flushAllExpected()]);

        const eventId = await bridge.handleMessage({
            id: "abc",
            time: 1,
            event: "message",
            topic: "alerts",
            message: "noisy low priority",
            priority: 2,
        });
        expect(eventId).toBeNull();
    });

    it('should resolve a previously stored room from account data', async () => {
        const { client, http } = createTestClient(null, selfUserId);
        const storedRoom = "!stored:example.org";
        const bridge = new NtfyMatrixBridge(client, {
            ntfy: { topic: "alerts" },
            cleanup: false,
        });

        http.when("GET", bridgePath()).respond(200, { roomId: storedRoom });

        const [resolved] = await Promise.all([bridge.start(), http.flushAllExpected()]);
        expect(resolved).toEqual(storedRoom);
        expect(bridge.serviceRoomId).toEqual(storedRoom);
    });

    it('should create a hidden service room when none exists', async () => {
        const { client, http } = createTestClient(null, selfUserId);
        const createdRoom = "!created:example.org";
        const bridge = new NtfyMatrixBridge(client, {
            ntfy: { topic: "alerts" },
            cleanup: false,
            inviteUserIds: ["@user:example.org"],
        });

        http.when("GET", bridgePath()).respond(404, { errcode: "M_NOT_FOUND", error: "Not found" });
        http.when("POST", "/createRoom").respond(200, (path, body) => {
            expect(body.visibility).toEqual("private");
            expect(body.invite).toEqual(["@user:example.org"]);
            expect((body.initial_state as any[]).some((s: any) => s.type === "world.ixo.ntfy.service_room")).toBe(true);
            return { room_id: createdRoom };
        });
        http.when("PUT", bridgePath()).respond(200, {});

        const [resolved] = await Promise.all([bridge.start(), http.flushAllExpected()]);
        expect(resolved).toEqual(createdRoom);
    });
});

describe('defaultFormatMessage', () => {
    it('should render title, body, tags and click link', () => {
        const formatted = defaultFormatMessage({
            id: "x",
            time: 1,
            event: "message",
            topic: "ops",
            title: "Backup failed",
            message: "Nightly backup did not run",
            tags: ["warning", "skull"],
            click: "https://status.example.org",
        });
        expect(formatted.body).toContain("Backup failed");
        expect(formatted.body).toContain("Nightly backup did not run");
        expect(formatted.body).toContain("warning, skull");
        expect(formatted.body).toContain("https://status.example.org");
        expect(formatted.formatted_body).toContain("<strong>Backup failed</strong>");
        expect(formatted.formatted_body).toContain("<a href=\"https://status.example.org\">");
    });

    it('should escape HTML in untrusted fields', () => {
        const formatted = defaultFormatMessage({
            id: "x",
            time: 1,
            event: "message",
            topic: "ops",
            title: "<script>alert(1)</script>",
            message: "a & b < c",
        });
        expect(formatted.formatted_body).not.toContain("<script>");
        expect(formatted.formatted_body).toContain("&lt;script&gt;");
        expect(formatted.formatted_body).toContain("a &amp; b &lt; c");
    });

    it('should fall back to a placeholder for an empty alert', () => {
        const formatted = defaultFormatMessage({ id: "x", time: 1, event: "message", topic: "ops" });
        expect(formatted.body).toEqual("(empty alert)");
    });
});
