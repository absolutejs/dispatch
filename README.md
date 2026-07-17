# @absolutejs/dispatch

Provider-agnostic outbound message dispatcher for the AbsoluteJS
ecosystem.

**Docs:** [absolutejs.com/documentation/dispatch-overview](https://absolutejs.com/documentation/dispatch-overview)

**What it is.** One factory (`createDispatcher`) returning a
`Dispatcher` with three channels (`email` / `sms` / `push`). Adapters
plug into each channel. The substrate around the adapters — metrics,
OTel, audit emission, error handling — is uniform.

**What it solves.** Every package that needs to send a transactional
message currently brings its own SMTP / SMS / push client.
`@absolutejs/auth`'s magic-link routes assume the host emails the
token. `@absolutejs/sync-pack-digest` explicitly says "_Host-supplied
email sender. The pack does NOT own transport_". The control plane
needs invoice-failed / quota-warning emails. Centralizing through one
dispatcher means each consumer plugs into one place.

## Install

```sh
bun add @absolutejs/dispatch
# Plus one or more adapter siblings:
bun add @absolutejs/dispatch-resend       # Resend (email)
bun add @absolutejs/dispatch-postmark     # Postmark (email)
bun add @absolutejs/dispatch-twilio       # Twilio (SMS)
# ...etc
```

## Usage

```ts
import { createDispatcher } from "@absolutejs/dispatch";
import { createResendAdapter } from "@absolutejs/dispatch-resend";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_KEY!);

const dispatcher = createDispatcher({
  email: createResendAdapter({ client: resend }),
  defaultFrom: { email: "no-reply@acme.io" },
});

await dispatcher.email({
  to: "alice@example.com",
  subject: "Welcome to Acme",
  text: "Hi Alice, click here to verify: ...",
  tenant: "tenant-A", // optional — propagates to OTel + audit
});
```

## API

### `createDispatcher(options)`

```ts
type DispatcherOptions = {
  email?: EmailAdapter;
  sms?: SmsAdapter;
  push?: PushAdapter;
  defaultFrom?: { email?: string; sms?: string };
  onError?: (error: unknown, channel: DispatchChannel, message) => void;
  tracerProvider?: TracerProvider; // OTel
  audit?: AuditLike; // @absolutejs/audit instance
};
```

Returns `{ email, sms, push, metrics }`. Calling a channel without an
adapter throws `DispatchUnsupportedError`.

### `dispatcher.email(message)` / `.sms(message)` / `.push(message)`

```ts
type EmailMessage = {
  to: string | ReadonlyArray<string>;
  from?: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  cc?: string | ReadonlyArray<string>;
  bcc?: string | ReadonlyArray<string>;
  headers?: Record<string, string>;
  tenant?: string;
  metadata?: Record<string, unknown>; // adapter-specific extras
};

type SmsMessage = {
  to: string; // E.164
  from?: string;
  body: string;
  tenant?: string;
  metadata?: Record<string, unknown>;
};

type PushMessage = {
  to: string; // device token OR topic
  title?: string;
  body: string;
  data?: Record<string, unknown>;
  tenant?: string;
  metadata?: Record<string, unknown>;
};
```

Returns `DispatchResult { id?, provider, at }`. Throws on adapter
failure; `onError` fires before re-throw.

### `dispatcher.metrics()`

```ts
{
  sent: number;
  failed: number;
  byChannel: {
    email: {
      sent, failed;
    }
    sms: {
      sent, failed;
    }
    push: {
      sent, failed;
    }
  }
}
```

## Substrate pattern

### OpenTelemetry

When `tracerProvider` is set, every send emits a
`dispatch.<channel>.send` span (`dispatch.email.send`, etc.) with:

- `abs.tenant` (when `message.tenant` is supplied)
- `dispatch.channel` (`email` / `sms` / `push`)
- `dispatch.provider` (the adapter name, updated to the result provider on success)
- `dispatch.recipient_count` (addresses are intentionally excluded from spans)
- `dispatch.message_id` (when the adapter returns one)

Updating the provider from the result keeps broker/delegating adapters
observable without leaking their routing implementation.

Status `OK` on success; `ERROR` + `recordException` on failure.

### Audit emission

When `audit` is supplied (any `@absolutejs/audit` `Audit` instance),
every send emits a `dispatch.<channel>.<outcome>` event:

- `kind`: `dispatch.email.sent` / `dispatch.email.failed` (etc.)
- `actor`: `message.tenant` (when set), else `'system'`
- `target`: the recipient
- `metadata`: `{ channel, provider, messageId?, error? }`

Audit emission is fire-and-forget — if your audit sink fails, the
dispatch still succeeds. Audit failures are logged to `console.warn`.

The audit dep is **optional** — `@absolutejs/audit` is a peer-dep with
`peerDependenciesMeta.optional: true`, so consumers without it
installed just pass `audit: undefined`.

## Bundled adapters

These ship in core for tests + dev. Production deployments use the
sibling vendor adapters.

### `memoryEmailAdapter({ max?, idGenerator? })`

In-process FIFO tail. `inspect()` returns captured messages oldest-
first; `clear()` empties. Useful for asserting "did we email Alice
when she signed up?" in tests without a real SMTP server.

### `memorySmsAdapter({ max? })` / `memoryPushAdapter({ max? })`

Same shape, same usage.

### `consoleEmailAdapter({ stream? })` / `consoleSmsAdapter` / `consolePushAdapter`

JSON-per-line to stdout (or stderr). Useful for `bun --watch` dev so
you can see exactly what would be sent without burning provider
credits.

## What this package does NOT do

- **Template rendering.** Messages are pre-rendered. Pair with
  `@react-email`, `mjml`, `handlebars`, or whatever you like.
- **Per-recipient rate limiting.** Compose with
  `@absolutejs/rate-limit` for "max 5 magic-links per email per hour"
  gating.
- **Bounce / complaint handling.** Each provider's SDK exposes
  webhooks for these.
- **Scheduling / queueing.** For delayed sends use `@absolutejs/queue`
  with a handler that calls `dispatcher.email(...)`.

## License

[BSL-1.1](./LICENSE) with a Tier-A carveout: you can't use this to
operate a hosted message-dispatch / transactional-email / SMS / push
SaaS that competes with hosted offerings (Resend, Postmark, SendGrid,
Mailgun, AWS SES managed, Twilio, Vonage, Pushwoosh, OneSignal, FCM
managed, Knock). You CAN use it as one piece of your own application
(including your own SaaS). Auto-converts to Apache 2.0 on 2030-05-30.
