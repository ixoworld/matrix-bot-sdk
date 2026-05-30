/**
 * The kinds of events emitted by an ntfy subscription stream. Only `message`
 * events carry an actual notification - the others are control frames used to
 * keep the connection alive or to signal that the stream has opened.
 * @see https://docs.ntfy.sh/subscribe/api/
 * @category Ntfy alerts
 */
export type NtfyEventType = "open" | "keepalive" | "message" | "poll_request";

/**
 * An action button attached to an ntfy notification.
 * @category Ntfy alerts
 */
export interface NtfyAction {
    /**
     * The action type, such as `view`, `http`, or `broadcast`.
     */
    action: string;

    /**
     * The label shown to the user for the action.
     */
    label: string;

    /**
     * The URL associated with the action, if any.
     */
    url?: string;

    [key: string]: any;
}

/**
 * An attachment included with an ntfy notification.
 * @category Ntfy alerts
 */
export interface NtfyAttachment {
    /**
     * The attachment's file name.
     */
    name: string;

    /**
     * A URL pointing at the attachment.
     */
    url: string;

    /**
     * The attachment's MIME type, if known.
     */
    type?: string;

    /**
     * The attachment's size in bytes, if known.
     */
    size?: number;

    [key: string]: any;
}

/**
 * A single message received from an ntfy topic. This mirrors the JSON message
 * format documented by ntfy.sh. Fields other than `id`, `time`, `event` and
 * `topic` are only present on `message` events.
 * @see https://docs.ntfy.sh/subscribe/api/#json-message-format
 * @category Ntfy alerts
 */
export interface NtfyMessage {
    /**
     * Randomly chosen message identifier, unique per topic.
     */
    id: string;

    /**
     * The timestamp the message was received, in unix seconds.
     */
    time: number;

    /**
     * The timestamp the message expires server-side, in unix seconds.
     */
    expires?: number;

    /**
     * The kind of stream frame this object represents.
     */
    event: NtfyEventType;

    /**
     * The topic the message was published to.
     */
    topic: string;

    /**
     * The message body.
     */
    message?: string;

    /**
     * The message title.
     */
    title?: string;

    /**
     * The message priority, from 1 (min) to 5 (max). Defaults to 3.
     */
    priority?: number;

    /**
     * The tags attached to the message. Some tags are rendered as emoji by ntfy.
     */
    tags?: string[];

    /**
     * A URL to open when the notification is clicked.
     */
    click?: string;

    /**
     * A URL to an icon shown alongside the notification.
     */
    icon?: string;

    /**
     * The action buttons attached to the notification.
     */
    actions?: NtfyAction[];

    /**
     * The attachment included with the notification, if any.
     */
    attachment?: NtfyAttachment;

    [key: string]: any;
}
