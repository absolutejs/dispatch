/**
 * @absolutejs/dispatch — provider-agnostic outbound message dispatcher
 * for the AbsoluteJS ecosystem.
 *
 * **The problem this solves.** The deep-research audit flagged G4:
 * every package that needs to send a transactional message brings its
 * own SMTP / SMS / push client. `@absolutejs/auth`'s magic-link routes
 * assume the host emails the token; `@absolutejs/sync-pack-digest`
 * explicitly says "*Host-supplied email sender. The pack does NOT own
 * transport*"; the eventual `absolutejs.ai` control plane needs
 * invoice-failed / quota-warning / breach-notification emails. Each
 * consumer writes its own Resend / Postmark / SES wrapper.
 *
 * **The shape this package provides.** One factory
 * (`createDispatcher`) returning a `Dispatcher` with three channels
 * (`email` / `messaging` / `push`). Each channel takes an adapter — bundled
 * in core: `memoryEmailAdapter` / `memoryMessagingAdapter` / `memoryPushAdapter`
 * (in-process tail; useful in tests) and `consoleEmailAdapter` /
 * `consoleMessagingAdapter` / `consolePushAdapter` (log to stdout for dev).
 * Provider-specific adapters live as siblings in
 * `@absolutejs/dispatch-adapters/*` (`dispatch-resend`, `dispatch-postmark`,
 * `dispatch-twilio`, etc.) — same pattern as audit-adapters and
 * queue-adapters.
 *
 * **Substrate-pattern uniformity:**
 *
 *   - `dispatcher.metrics()` — cumulative counters per channel
 *     (sent / failed) plus an aggregate.
 *   - **OTel via `@absolutejs/telemetry`** — every channel call emits
 *     a `dispatch.<channel>.send` span with `ABS_ATTRS.tenant` (if a
 *     `tenant` is set on the message) and provider-specific result
 *     attributes (provider name, message id when adapter returns one).
 *   - **Optional audit emission via `@absolutejs/audit`** — pass an
 *     `Audit` and every send emits `dispatch.<channel>.sent` or
 *     `dispatch.<channel>.failed` events with the recipient as
 *     `target`, provider as metadata. The audit dep is optional —
 *     consumers without `@absolutejs/audit` installed skip the field
 *     entirely.
 *
 * **What this package does NOT do:**
 *
 *   - **Template rendering.** Messages are pre-rendered (caller
 *     supplies `subject` + `text`/`html`). Template engines are out of
 *     scope; pair with any (`@react-email`, `mjml`, plain
 *     `handlebars`).
 *   - **Per-recipient rate limiting.** Compose with
 *     `@absolutejs/rate-limit` for "max 5 magic-links per email per
 *     hour" gating.
 *   - **Bounce / complaint handling.** Each provider exposes webhooks
 *     for these; the adapter shape leaves that to the provider's SDK
 *     + the consumer's webhook handler.
 *   - **Scheduling / queueing.** For "send at 2026-06-01T09:00:00Z"
 *     use `@absolutejs/queue` with a delayed-job handler that calls
 *     `dispatcher.email(...)`.
 */

import {
  ABS_ATTRS,
  tracerOrNoop,
  type TracerProvider,
} from "@absolutejs/telemetry";

/**
 * Optional reference to `@absolutejs/audit`. We don't import the type
 * directly — that would force consumers to install audit even when
 * unused. We accept anything structurally compatible with the minimal
 * `append` shape.
 */
export type AuditLike = {
  append: (event: {
    kind: string;
    actor?: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
};

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

export type EmailMessage = {
  to: string | ReadonlyArray<string>;
  from?: string;
  /** Stable provider idempotency key for retry-safe delivery. */
  idempotencyKey?: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  cc?: string | ReadonlyArray<string>;
  bcc?: string | ReadonlyArray<string>;
  headers?: Record<string, string>;
  /**
   * Optional tenant identifier. When set, propagates to the OTel span
   * as `abs.tenant` and to the audit event as `actor`. The recipient
   * (`to`) is the `target` regardless.
   */
  tenant?: string;
  /** Adapter-specific extras (tracking ids, tags, custom headers). */
  metadata?: Record<string, unknown>;
};

/**
 * Adapter packages extend this registry through module augmentation. This
 * keeps core exhaustive for its built-in transports without forcing a core
 * release whenever a provider introduces another channel.
 */
export interface MessagingTransportRegistry {
  mms: { family: "carrier" };
  rcs: { family: "rich" };
  sms: { family: "carrier" };
  whatsapp: { family: "ott" };
}

export type MessagingTransport = Extract<
  keyof MessagingTransportRegistry,
  string
>;

export type MessagingEndpoint = {
  address: string;
  transport: MessagingTransport;
};

export type MessagingAction =
  | { kind: "dial"; label: string; phoneNumber: string }
  | { kind: "location"; label: string; latitude: number; longitude: number }
  | { kind: "reply"; label: string; payload: string }
  | { kind: "url"; label: string; url: string };

export type MessagingContent =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      mediaUrls: ReadonlyArray<string>;
      subject?: string;
      text?: string;
    }
  | {
      kind: "template";
      id: string;
      variables?: Readonly<Record<string, string>>;
    }
  | {
      actions?: ReadonlyArray<MessagingAction>;
      extensions?: Readonly<Record<string, unknown>>;
      kind: "rich";
      mediaUrl?: string;
      text: string;
      title?: string;
    };

export type MessagingFallbackRoute = {
  content?: MessagingContent;
  from?: MessagingEndpoint;
  transport: MessagingTransport;
};

export type MessagingMessage = {
  /** Typed primary recipient and requested transport. */
  to: MessagingEndpoint;
  /** Typed primary sender. Providers may select one from a configured pool when omitted. */
  from?: MessagingEndpoint;
  /** Exactly one portable content representation. */
  content: MessagingContent;
  /** Ordered provider fallback routes. Consent is evaluated for every route automatically. */
  fallbacks?: ReadonlyArray<MessagingFallbackRoute>;
  /** ISO-8601 delivery time for providers that support native scheduling. */
  sendAt?: string;
  /** Stable adapter idempotency key for retry-safe delivery. */
  idempotencyKey?: string;
  /** Provider retention controls for message content and addressing data. */
  privacy?: {
    addressRetention?: "obfuscate" | "retain";
    contentRetention?: "discard" | "retain";
  };
  /** Consent identity evaluated for the primary and every fallback route. */
  consent?: {
    /** Stable messaging program identity across provider accounts and sender pools. */
    programId: string;
    /** Consent purpose, such as `incident-alerts` or `login-verification`. */
    purpose: string;
  };
  /** Typed provider extensions, keyed by provider name. */
  extensions?: Readonly<Record<string, unknown>>;
  tenant?: string;
  metadata?: Record<string, unknown>;
};

export type PushMessage = {
  /**
   * Device token (FCM/APNs) OR topic name. Adapter decides the
   * interpretation; see each adapter's docs.
   */
  to: string;
  title?: string;
  body: string;
  /** Free-form data payload sent alongside the notification. */
  data?: Record<string, unknown>;
  /**
   * Privacy-safe identifier for logs and audit events, such as a durable
   * subscription id. Raw device tokens are never used as push audit targets.
   */
  safeTarget?: string;
  tenant?: string;
  metadata?: Record<string, unknown>;
};

export type DispatchChannel = "email" | "messaging" | "push";

/**
 * Returned by every `send` on every adapter. `id` is the provider's
 * tracking identifier (Resend message id, Twilio SID, FCM message id)
 * when the provider returns one; `provider` is the adapter's name.
 */
export type DispatchResult = {
  id?: string;
  provider: string;
  at: number;
};

export type MessagingDeliveryStatus =
  | "accepted"
  | "canceled"
  | "delivered"
  | "expired"
  | "failed"
  | "queued"
  | "read"
  | "scheduled"
  | "sending"
  | "sent"
  | "undeliverable"
  | "unknown";

export type MessagingFailure = {
  code?: string;
  detail?: string;
  title?: string;
};

export type MessagingEconomics = {
  currency: string;
  price: string;
  segments?: number;
};

export type MessagingDeliveryAttempt = {
  actualTransport?: MessagingTransport;
  errors?: ReadonlyArray<MessagingFailure>;
  providerMessageId?: string;
  providerStatus?: string;
  route: "primary" | { fallbackIndex: number };
  status: MessagingDeliveryStatus;
  transport: MessagingTransport;
};

export type MessagingDispatchResult = DispatchResult & {
  delivery: {
    actualTransport?: MessagingTransport;
    attempts: ReadonlyArray<MessagingDeliveryAttempt>;
    requestedTransport: MessagingTransport;
  };
};

export type MessagingEventBase = {
  actualTransport?: MessagingTransport;
  eventId: string;
  from?: MessagingEndpoint;
  messageId: string;
  occurredAt: number;
  provider: string;
  providerAccountId?: string;
  requestedTransport?: MessagingTransport;
  tenant?: string;
  to?: MessagingEndpoint;
};

export type MessagingDeliveryEvent = MessagingEventBase & {
  attempt?: MessagingDeliveryAttempt;
  economics?: MessagingEconomics;
  errors: ReadonlyArray<MessagingFailure>;
  kind: "delivery";
  networkCode?: string;
  providerStatus: string;
  status: MessagingDeliveryStatus;
};

export type MessagingInboundEvent = MessagingEventBase & {
  content: MessagingContent;
  interaction?: {
    label?: string;
    payload: string;
  };
  kind: "inbound";
};

export type MessagingConsentEvent = MessagingEventBase & {
  action: "grant" | "help" | "revoke";
  keyword?: string;
  kind: "consent";
};

export type MessagingEvent =
  | MessagingConsentEvent
  | MessagingDeliveryEvent
  | MessagingInboundEvent;

export type MessagingEventHandler = (
  event: MessagingEvent,
) => Promise<void> | void;

export type MessagingCapabilityCheck = {
  detail: string;
  id: string;
  status: "fail" | "pass" | "pending";
};

export type MessagingCapabilityReport = {
  checks: ReadonlyArray<MessagingCapabilityCheck>;
  ready: boolean;
};

export type MessagingScheduledMessageReport = {
  messageId: string;
  providerStatus: string;
  state: "canceled" | "failed" | "pending" | "sent";
};

export type MessagingSchedulingCapability = {
  cancel: (messageId: string) => Promise<MessagingScheduledMessageReport>;
  inspect: (messageId: string) => Promise<MessagingScheduledMessageReport>;
};

export type MessagingReadinessCapability = {
  inspect: () => Promise<MessagingCapabilityReport>;
};

export type MessagingRegistrationCapability<Input = unknown> = {
  inspect: (input: Input) => Promise<MessagingCapabilityReport>;
};

// -----------------------------------------------------------------------------
// Adapter contracts
// -----------------------------------------------------------------------------

export type EmailAdapter = {
  send: (message: EmailMessage) => Promise<DispatchResult>;
  readonly name: string;
};

export type MessagingAdapter = {
  capabilities?: {
    readiness?: MessagingReadinessCapability;
    scheduling?: MessagingSchedulingCapability;
  };
  send: (message: MessagingMessage) => Promise<MessagingDispatchResult>;
  readonly name: string;
};

export type PushAdapter = {
  send: (message: PushMessage) => Promise<DispatchResult>;
  readonly name: string;
};

export type DispatchPolicyContext = {
  adapter: string;
  channel: DispatchChannel;
  message: EmailMessage | MessagingMessage | PushMessage;
};

export type DispatchPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

export type DispatchPolicy = {
  readonly name: string;
  evaluate: (
    context: DispatchPolicyContext,
  ) => DispatchPolicyDecision | Promise<DispatchPolicyDecision>;
};

export class DispatchPolicyDeniedError extends Error {
  readonly code: string;
  readonly policy: string;

  constructor(input: { code: string; policy: string; reason: string }) {
    super(`[dispatch] ${input.policy} denied send: ${input.reason}`);
    this.name = "DispatchPolicyDeniedError";
    this.code = input.code;
    this.policy = input.policy;
  }
}

// -----------------------------------------------------------------------------
// Dispatcher factory
// -----------------------------------------------------------------------------

export type DispatcherOptions = {
  email?: EmailAdapter;
  messaging?: MessagingAdapter;
  push?: PushAdapter;
  /** Ordered authorization policies evaluated before any provider call. */
  policies?: ReadonlyArray<DispatchPolicy>;
  /**
   * Default `from` per channel. Consumers can override per message.
   * Adapters MAY enforce their own defaults if these aren't set
   * (Resend requires `from`; SES requires a verified sender; etc).
   */
  defaultFrom?: {
    email?: string;
    messaging?: MessagingEndpoint;
  };
  /**
   * Per-send error hook. Defaults to `console.warn`. Fires AFTER the
   * audit emission and BEFORE re-throwing.
   */
  onError?: (
    error: unknown,
    channel: DispatchChannel,
    message: EmailMessage | MessagingMessage | PushMessage,
  ) => void;
  /**
   * Optional `@opentelemetry/api`-compatible `TracerProvider`. When
   * set, every send is wrapped in a `dispatch.<channel>.send` span.
   */
  tracerProvider?: TracerProvider;
  /**
   * Optional `@absolutejs/audit` instance. When set, every send
   * emits a `dispatch.<channel>.<outcome>` event with the recipient
   * as `target`. Consumers without `@absolutejs/audit` installed
   * pass `undefined`.
   */
  audit?: AuditLike;
  /** Override `Date.now` for tests. */
  clock?: () => number;
};

export type DispatcherChannelMetrics = {
  sent: number;
  failed: number;
};

export type DispatcherMetrics = {
  sent: number;
  failed: number;
  byChannel: Record<DispatchChannel, DispatcherChannelMetrics>;
};

export type Dispatcher = {
  email: (message: EmailMessage) => Promise<DispatchResult>;
  messaging: (message: MessagingMessage) => Promise<MessagingDispatchResult>;
  push: (message: PushMessage) => Promise<DispatchResult>;
  metrics: () => DispatcherMetrics;
};

export class DispatchUnsupportedError extends Error {
  readonly channel: DispatchChannel;
  constructor(channel: DispatchChannel) {
    super(
      `[dispatch] no ${channel} adapter configured — pass createDispatcher({ ${channel}: <adapter> }) to use this channel.`,
    );
    this.name = "DispatchUnsupportedError";
    this.channel = channel;
  }
}

const toCsv = (
  value: string | ReadonlyArray<string> | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return value.join(",");
};

const recipientOf = (
  channel: DispatchChannel,
  message: EmailMessage | MessagingMessage | PushMessage,
): string => {
  if (channel === "email") {
    return toCsv((message as EmailMessage).to) ?? "";
  }
  return channel === "messaging"
    ? (message as MessagingMessage).to.address
    : (message as PushMessage).to;
};

const recipientCountOf = (
  channel: DispatchChannel,
  message: EmailMessage | MessagingMessage | PushMessage,
): number => {
  if (channel !== "email") return 1;
  const to = (message as EmailMessage).to;
  return typeof to === "string" ? 1 : to.length;
};

const operationalTargetOf = (
  channel: DispatchChannel,
  message: EmailMessage | MessagingMessage | PushMessage,
) => {
  if (channel !== "push") return recipientOf(channel, message);

  return (message as PushMessage).safeTarget ?? "push-recipient";
};

export const createDispatcher = (options: DispatcherOptions): Dispatcher => {
  const clock = options.clock ?? Date.now;
  const onError =
    options.onError ??
    ((error, channel, message) => {
      console.warn(
        `[dispatch] ${channel} send failed for ${operationalTargetOf(channel, message)}:`,
        error,
      );
    });
  const tracer = tracerOrNoop(options.tracerProvider, "@absolutejs/dispatch");
  const audit = options.audit;
  const defaultFromEmail = options.defaultFrom?.email;
  const defaultFromMessaging = options.defaultFrom?.messaging;

  const counters: DispatcherMetrics = {
    byChannel: {
      email: { failed: 0, sent: 0 },
      push: { failed: 0, sent: 0 },
      messaging: { failed: 0, sent: 0 },
    },
    failed: 0,
    sent: 0,
  };

  const emitAudit = (
    kind: string,
    message: EmailMessage | MessagingMessage | PushMessage,
    channel: DispatchChannel,
    result: DispatchResult | undefined,
    error: unknown | undefined,
  ): void => {
    if (audit === undefined) return;
    const metadata: Record<string, unknown> = {
      channel,
      ...(result?.provider !== undefined ? { provider: result.provider } : {}),
      ...(result?.id !== undefined ? { messageId: result.id } : {}),
      ...(error !== undefined
        ? {
            error: error instanceof Error ? error.message : String(error),
          }
        : {}),
    };
    void audit
      .append({
        kind,
        ...(message.tenant !== undefined
          ? { actor: message.tenant }
          : { actor: "system" }),
        target: operationalTargetOf(channel, message),
        metadata,
      })
      .catch((auditError) => {
        console.warn("[dispatch] audit emission failed:", auditError);
      });
  };

  const dispatch = async <
    M extends EmailMessage | MessagingMessage | PushMessage,
    R extends DispatchResult,
  >(
    channel: DispatchChannel,
    message: M,
    adapter: EmailAdapter | MessagingAdapter | PushAdapter | undefined,
    runSend: (
      adapter: EmailAdapter | MessagingAdapter | PushAdapter,
    ) => Promise<R>,
  ): Promise<R> => {
    if (adapter === undefined) {
      throw new DispatchUnsupportedError(channel);
    }
    const span = tracer.startSpan(`dispatch.${channel}.send`, {
      attributes: {
        ...(message.tenant !== undefined
          ? { [ABS_ATTRS.tenant]: message.tenant }
          : {}),
        "dispatch.channel": channel,
        "dispatch.provider": adapter.name,
        "dispatch.recipient_count": recipientCountOf(channel, message),
      },
    });
    try {
      for (const policy of options.policies ?? []) {
        const decision = await policy.evaluate({
          adapter: adapter.name,
          channel,
          message,
        });
        if (!decision.allowed) {
          throw new DispatchPolicyDeniedError({
            code: decision.code,
            policy: policy.name,
            reason: decision.reason,
          });
        }
      }
      const result = await runSend(adapter);
      counters.sent += 1;
      counters.byChannel[channel].sent += 1;
      span.setAttribute("dispatch.provider", result.provider);
      if (result.id !== undefined) {
        span.setAttribute("dispatch.message_id", result.id);
      }
      span.setStatus({ code: 1 /* OK */ });
      emitAudit(
        `dispatch.${channel}.sent`,
        message,
        channel,
        result,
        undefined,
      );
      return result;
    } catch (error) {
      counters.failed += 1;
      counters.byChannel[channel].failed += 1;
      span.recordException(error);
      span.setStatus({
        code: 2 /* ERROR */,
        message: error instanceof Error ? error.message : String(error),
      });
      emitAudit(
        `dispatch.${channel}.failed`,
        message,
        channel,
        undefined,
        error,
      );
      onError(error, channel, message);
      throw error;
    } finally {
      span.end();
    }
  };

  return {
    email: (message) =>
      dispatch("email", message, options.email, (adapter) =>
        (adapter as EmailAdapter).send({
          ...message,
          from: message.from ?? defaultFromEmail,
        }),
      ),
    metrics: (): DispatcherMetrics => ({
      byChannel: {
        email: { ...counters.byChannel.email },
        push: { ...counters.byChannel.push },
        messaging: { ...counters.byChannel.messaging },
      },
      failed: counters.failed,
      sent: counters.sent,
    }),
    push: (message) =>
      dispatch("push", message, options.push, (adapter) =>
        (adapter as PushAdapter).send(message),
      ),
    messaging: (message) =>
      dispatch("messaging", message, options.messaging, (adapter) =>
        (adapter as MessagingAdapter).send({
          ...message,
          from: message.from ?? defaultFromMessaging,
        }),
      ),
  };

  // `clock` is unused in the default factory but reserved for future
  // adapters that need a deterministic timestamp source in tests.
  void clock;
};

// -----------------------------------------------------------------------------
// Bundled adapters
// -----------------------------------------------------------------------------

export type MemoryEmailAdapterOptions = {
  max?: number;
  /** Override the result's `id`. Default: a UUID. */
  idGenerator?: (message: EmailMessage) => string;
};

/**
 * In-process tail of sent emails. Useful in tests and dev — assert
 * what was sent without round-tripping a real provider.
 *
 * `inspect()` returns the captured messages oldest-first. Drops the
 * oldest FIFO when `max` is reached (default 1000).
 */
export type MemoryEmailAdapter = EmailAdapter & {
  inspect: () => ReadonlyArray<EmailMessage & { id: string; at: number }>;
  clear: () => void;
};

export const memoryEmailAdapter = (
  options: MemoryEmailAdapterOptions = {},
): MemoryEmailAdapter => {
  const max = options.max ?? 1000;
  const sent: Array<EmailMessage & { id: string; at: number }> = [];
  return {
    clear: () => {
      sent.length = 0;
    },
    inspect: () => [...sent],
    name: "memory",
    send: async (message) => {
      const id = options.idGenerator?.(message) ?? crypto.randomUUID();
      const at = Date.now();
      sent.push({ ...message, at, id });
      while (sent.length > max) sent.shift();
      return { at, id, provider: "memory" };
    },
  };
};

export type MemoryMessagingAdapter = MessagingAdapter & {
  inspect: () => ReadonlyArray<MessagingMessage & { id: string; at: number }>;
  clear: () => void;
};

export const memoryMessagingAdapter = (
  options: { max?: number } = {},
): MemoryMessagingAdapter => {
  const max = options.max ?? 1000;
  const sent: Array<MessagingMessage & { id: string; at: number }> = [];
  return {
    clear: () => {
      sent.length = 0;
    },
    inspect: () => [...sent],
    name: "memory",
    send: async (message) => {
      const id = crypto.randomUUID();
      const at = Date.now();
      sent.push({ ...message, at, id });
      while (sent.length > max) sent.shift();
      return {
        at,
        delivery: {
          actualTransport: message.to.transport,
          attempts: [
            {
              actualTransport: message.to.transport,
              providerMessageId: id,
              route: "primary",
              status: "accepted",
              transport: message.to.transport,
            },
          ],
          requestedTransport: message.to.transport,
        },
        id,
        provider: "memory",
      };
    },
  };
};

export type MemoryPushAdapter = PushAdapter & {
  inspect: () => ReadonlyArray<PushMessage & { id: string; at: number }>;
  clear: () => void;
};

export const memoryPushAdapter = (
  options: { max?: number } = {},
): MemoryPushAdapter => {
  const max = options.max ?? 1000;
  const sent: Array<PushMessage & { id: string; at: number }> = [];
  return {
    clear: () => {
      sent.length = 0;
    },
    inspect: () => [...sent],
    name: "memory",
    send: async (message) => {
      const id = crypto.randomUUID();
      const at = Date.now();
      sent.push({ ...message, at, id });
      while (sent.length > max) sent.shift();
      return { at, id, provider: "memory" };
    },
  };
};

// -----------------------------------------------------------------------------
// Console adapters (dev)
// -----------------------------------------------------------------------------

export type ConsoleAdapterOptions = {
  stream?: "log" | "error";
};

export const consoleEmailAdapter = (
  options: ConsoleAdapterOptions = {},
): EmailAdapter => {
  const stream = options.stream ?? "log";
  return {
    name: "console",
    send: async (message) => {
      const out = JSON.stringify({ channel: "email", message }, null, 2);
      if (stream === "error") console.error(out);
      else console.log(out);
      return { at: Date.now(), provider: "console" };
    },
  };
};

export const consoleMessagingAdapter = (
  options: ConsoleAdapterOptions = {},
): MessagingAdapter => {
  const stream = options.stream ?? "log";
  return {
    name: "console",
    send: async (message) => {
      const out = JSON.stringify({ channel: "messaging", message }, null, 2);
      if (stream === "error") console.error(out);
      else console.log(out);
      return {
        at: Date.now(),
        delivery: {
          actualTransport: message.to.transport,
          attempts: [
            {
              actualTransport: message.to.transport,
              route: "primary",
              status: "accepted",
              transport: message.to.transport,
            },
          ],
          requestedTransport: message.to.transport,
        },
        provider: "console",
      };
    },
  };
};

export const consolePushAdapter = (
  options: ConsoleAdapterOptions = {},
): PushAdapter => {
  const stream = options.stream ?? "log";
  return {
    name: "console",
    send: async (message) => {
      const out = JSON.stringify({ channel: "push", message }, null, 2);
      if (stream === "error") console.error(out);
      else console.log(out);
      return { at: Date.now(), provider: "console" };
    },
  };
};
