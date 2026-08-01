import { describe, expect, test } from "bun:test";
import {
  ABS_ATTRS,
  createNoopSpan,
  type Span,
  type Tracer,
  type TracerProvider,
} from "@absolutejs/telemetry";
import {
  createDispatcher,
  memoryEmailAdapter,
  memoryMessagingAdapter,
  type EmailAdapter,
} from "../src/index";

type CapturedSpan = {
  name: string;
  attrs: Record<string, unknown>;
  status?: { code: number };
  exception?: unknown;
  ended: boolean;
};

const makeCapturingTracerProvider = () => {
  const spans: CapturedSpan[] = [];
  const makeSpan = (record: CapturedSpan): Span => {
    const noop = createNoopSpan();
    return {
      ...noop,
      end: () => {
        record.ended = true;
      },
      isRecording: () => !record.ended,
      recordException: (exception) => {
        record.exception = exception;
      },
      setAttribute: ((key: string, value: unknown) => {
        record.attrs[key] = value;
        return makeSpan(record);
      }) as Span["setAttribute"],
      setStatus: ((status) => {
        record.status = status;
        return makeSpan(record);
      }) as Span["setStatus"],
    };
  };
  const tracer: Tracer = {
    startActiveSpan: ((name, optionsOrFn, maybeFn) => {
      const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
      const record: CapturedSpan = { attrs: {}, ended: false, name };
      spans.push(record);
      return (fn as (s: Span) => unknown)(makeSpan(record));
    }) as Tracer["startActiveSpan"],
    startSpan: (name, options) => {
      const record: CapturedSpan = {
        attrs: { ...(options?.attributes ?? {}) },
        ended: false,
        name,
      };
      spans.push(record);
      return makeSpan(record);
    },
  };
  const provider: TracerProvider = { getTracer: () => tracer };
  return { provider, spans };
};

describe("dispatch 0.0.1 — OTel tracing", () => {
  test("emits dispatch.email.send span with tenant + recipient count + provider", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    const dispatcher = createDispatcher({
      email: memoryEmailAdapter(),
      tracerProvider: provider,
    });
    const result = await dispatcher.email({
      subject: "hi",
      tenant: "tenant-A",
      text: "t",
      to: "alice@example.com",
    });
    const span = spans.find((s) => s.name === "dispatch.email.send");
    expect(span).toBeDefined();
    expect(span!.attrs[ABS_ATTRS.tenant]).toBe("tenant-A");
    expect(span!.attrs["dispatch.channel"]).toBe("email");
    expect(span!.attrs["dispatch.provider"]).toBe("memory");
    expect(span!.attrs["dispatch.recipient_count"]).toBe(1);
    expect(span!.attrs["dispatch.recipient"]).toBeUndefined();
    expect(span!.attrs["dispatch.message_id"]).toBe(result.id);
    expect(span!.status?.code).toBe(1);
    expect(span!.ended).toBe(true);
  });

  test("records exception + ERROR on failure", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    const broken: EmailAdapter = {
      name: "broken",
      send: async () => {
        throw new Error("SMTP timeout");
      },
    };
    const dispatcher = createDispatcher({
      email: broken,
      onError: () => {
        // swallow
      },
      tracerProvider: provider,
    });
    await expect(
      dispatcher.email({ subject: "s", text: "t", to: "a@b.c" }),
    ).rejects.toThrow("SMTP timeout");
    const span = spans.find((s) => s.name === "dispatch.email.send");
    expect(span!.status?.code).toBe(2);
    expect(span!.exception).toBeInstanceOf(Error);
    expect(span!.ended).toBe(true);
  });

  test("multi-channel calls emit channel-specific span names", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    const dispatcher = createDispatcher({
      email: memoryEmailAdapter(),
      messaging: memoryMessagingAdapter(),
      tracerProvider: provider,
    });
    await dispatcher.email({ subject: "s", text: "t", to: "a@b.c" });
    await dispatcher.messaging({
      content: { kind: "text", text: "b" },
      to: { address: "+1", transport: "sms" },
    });
    const names = spans.map((s) => s.name);
    expect(names).toContain("dispatch.email.send");
    expect(names).toContain("dispatch.messaging.send");
  });

  test("email arrays expose only a privacy-safe recipient count", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    const dispatcher = createDispatcher({
      email: memoryEmailAdapter(),
      tracerProvider: provider,
    });
    await dispatcher.email({
      subject: "s",
      text: "t",
      to: ["alice@example.com", "bob@example.com"],
    });
    const span = spans.find((s) => s.name === "dispatch.email.send");
    expect(span!.attrs["dispatch.recipient_count"]).toBe(2);
    expect(span!.attrs["dispatch.recipient"]).toBeUndefined();
  });

  test("successful delegated sends report the result provider", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    const delegated: EmailAdapter = {
      name: "brokered-email",
      send: async () => ({ at: Date.now(), provider: "resend" }),
    };
    const dispatcher = createDispatcher({
      email: delegated,
      tracerProvider: provider,
    });
    await dispatcher.email({ subject: "s", text: "t", to: "a@b.c" });
    const span = spans.find((s) => s.name === "dispatch.email.send");
    expect(span!.attrs["dispatch.provider"]).toBe("resend");
  });

  test("without tracerProvider, dispatcher still works (noop)", async () => {
    const dispatcher = createDispatcher({
      email: memoryEmailAdapter(),
    });
    const result = await dispatcher.email({
      subject: "s",
      text: "t",
      to: "a@b.c",
    });
    expect(result.provider).toBe("memory");
  });
});
