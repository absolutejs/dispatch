# Changelog

## [0.0.1] — 2026-05-30

Initial preview. Provider-agnostic outbound message dispatcher
addressing G4 from the deep-research audit.

### Surface

- **`createDispatcher({ email?, sms?, push?, audit?, tracerProvider?, defaultFrom?, onError? })`** —
  factory. Returns `{ email, sms, push, metrics }`.
- **Three channels**: `email` / `sms` / `push` — each takes an
  adapter implementing `send(message): Promise<DispatchResult>`.
- **Bundled adapters** in core: `memoryEmailAdapter` /
  `memorySmsAdapter` / `memoryPushAdapter` (in-process FIFO tail with
  `inspect()` + `clear()`) and `consoleEmailAdapter` /
  `consoleSmsAdapter` / `consolePushAdapter` (JSON-per-line stdout for
  dev).
- **`DispatchUnsupportedError`** thrown when calling an
  un-configured channel.

### Substrate pattern

- **OpenTelemetry via `@absolutejs/telemetry`** — every send wrapped
  in a `dispatch.<channel>.send` span with `abs.tenant` (when message
  has `tenant`), `dispatch.channel`, `dispatch.provider`,
  `dispatch.recipient`, `dispatch.message_id`. Status OK / ERROR with
  `recordException`.
- **Optional audit emission via `@absolutejs/audit`** — every send
  emits `dispatch.<channel>.sent` / `dispatch.<channel>.failed` events
  with the recipient as `target`, channel + provider + messageId in
  `metadata`. `@absolutejs/audit` is an **optional peer dep**;
  consumers without it pass `audit: undefined`.
- **`metrics()`** — cumulative `sent` / `failed` aggregate + per-channel
  breakdown.

### Vendor adapters

Live as siblings in `@absolutejs/dispatch-adapters/*` (separate
publishes). The first sibling, `@absolutejs/dispatch-resend`, ships
alongside this release.

### Tested

22 tests across 2 files:
- per-channel send (email / sms / push) round-trips through memory adapters
- DispatchUnsupportedError on un-configured channel
- defaultFrom + per-message override precedence
- error path: adapter throws → counter bumped, error re-thrown
- audit: success emits `.sent`, failure emits `.failed`, actor falls back
  to `'system'` without tenant, audit-sink failure doesn't block dispatch
- metrics aggregation across channels
- memory adapter FIFO max + clear + custom idGenerator
- consoleEmailAdapter logs JSON to stdout
- OTel: spans emitted with attrs, ERROR on failure, channel-specific span
  names, csv recipient for email arrays, noop fallback

### License

BSL-1.1 Tier A — named carveout for hosted dispatch SaaS (Resend,
Postmark, SendGrid, Mailgun, AWS SES managed, Twilio, Vonage,
Pushwoosh, OneSignal, FCM managed, Knock). Auto-converts to Apache
2.0 on 2030-05-30.
