import { describe, expect, test } from "bun:test";
import {
  consoleEmailAdapter,
  createDispatcher,
  DispatchUnsupportedError,
  memoryEmailAdapter,
  memoryPushAdapter,
  memorySmsAdapter,
  type AuditLike,
  type EmailAdapter,
} from "../src/index";

describe("createDispatcher — basic per-channel send", () => {
  test("email round-trips through the memory adapter", async () => {
    const adapter = memoryEmailAdapter();
    const dispatcher = createDispatcher({ email: adapter });
    const result = await dispatcher.email({
      idempotencyKey: "email:welcome:alice",
      subject: "hello",
      text: "world",
      to: "alice@example.com",
    });
    expect(result.provider).toBe("memory");
    expect(result.id).toBeDefined();
    expect(adapter.inspect()).toHaveLength(1);
    expect(adapter.inspect()[0]!.to).toBe("alice@example.com");
    expect(adapter.inspect()[0]!.idempotencyKey).toBe("email:welcome:alice");
    expect(dispatcher.metrics().sent).toBe(1);
    expect(dispatcher.metrics().byChannel.email.sent).toBe(1);
  });

  test("sms round-trips through the memory adapter", async () => {
    const adapter = memorySmsAdapter();
    const dispatcher = createDispatcher({ sms: adapter });
    await dispatcher.sms({
      body: "pin: 482910",
      to: "+12025550100",
    });
    expect(adapter.inspect()).toHaveLength(1);
    expect(adapter.inspect()[0]!.body).toBe("pin: 482910");
  });

  test("push round-trips through the memory adapter", async () => {
    const adapter = memoryPushAdapter();
    const dispatcher = createDispatcher({ push: adapter });
    await dispatcher.push({
      body: "You have a new message",
      to: "device-token-abc",
      title: "New message",
    });
    expect(adapter.inspect()).toHaveLength(1);
  });

  test("calling an unconfigured channel throws DispatchUnsupportedError", async () => {
    const dispatcher = createDispatcher({});
    await expect(
      dispatcher.email({ subject: "s", text: "t", to: "a@b.c" }),
    ).rejects.toBeInstanceOf(DispatchUnsupportedError);
    await expect(
      dispatcher.sms({ body: "b", to: "+1" }),
    ).rejects.toBeInstanceOf(DispatchUnsupportedError);
    await expect(
      dispatcher.push({ body: "b", to: "token" }),
    ).rejects.toBeInstanceOf(DispatchUnsupportedError);
  });

  test("defaultFrom is applied when message omits from", async () => {
    const adapter = memoryEmailAdapter();
    const dispatcher = createDispatcher({
      defaultFrom: { email: "no-reply@example.com" },
      email: adapter,
    });
    await dispatcher.email({
      subject: "no-from",
      text: "t",
      to: "a@b.c",
    });
    expect(adapter.inspect()[0]!.from).toBe("no-reply@example.com");
  });

  test("per-message from overrides defaultFrom", async () => {
    const adapter = memoryEmailAdapter();
    const dispatcher = createDispatcher({
      defaultFrom: { email: "no-reply@example.com" },
      email: adapter,
    });
    await dispatcher.email({
      from: "support@example.com",
      subject: "override",
      text: "t",
      to: "a@b.c",
    });
    expect(adapter.inspect()[0]!.from).toBe("support@example.com");
  });
});

describe("error path — adapter throws", () => {
  test("failed send bumps counters + rethrows", async () => {
    const broken: EmailAdapter = {
      name: "broken",
      send: async () => {
        throw new Error("SMTP timeout");
      },
    };
    const errors: { error: unknown; channel: string }[] = [];
    const dispatcher = createDispatcher({
      email: broken,
      onError: (error, channel) => {
        errors.push({ channel, error });
      },
    });
    await expect(
      dispatcher.email({ subject: "s", text: "t", to: "a@b.c" }),
    ).rejects.toThrow("SMTP timeout");
    expect(dispatcher.metrics().failed).toBe(1);
    expect(dispatcher.metrics().byChannel.email.failed).toBe(1);
    expect(dispatcher.metrics().sent).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.channel).toBe("email");
  });
});

describe("audit integration", () => {
  test("emits dispatch.email.sent on success", async () => {
    const captured: Array<{
      kind: string;
      actor?: string;
      target?: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const audit: AuditLike = {
      append: async (event) => {
        captured.push(event);
      },
    };
    const dispatcher = createDispatcher({
      audit,
      email: memoryEmailAdapter(),
    });
    await dispatcher.email({
      subject: "welcome",
      tenant: "tenant-A",
      text: "hi",
      to: "alice@example.com",
    });
    // Audit emission is fire-and-forget; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe("dispatch.email.sent");
    expect(captured[0]!.actor).toBe("tenant-A");
    expect(captured[0]!.target).toBe("alice@example.com");
    expect(captured[0]!.metadata?.channel).toBe("email");
    expect(captured[0]!.metadata?.provider).toBe("memory");
  });

  test("emits dispatch.email.failed on adapter throw", async () => {
    const captured: Array<{ kind: string }> = [];
    const audit: AuditLike = {
      append: async (event) => {
        captured.push(event);
      },
    };
    const broken: EmailAdapter = {
      name: "broken",
      send: async () => {
        throw new Error("rejected");
      },
    };
    const dispatcher = createDispatcher({
      audit,
      email: broken,
      onError: () => {
        // swallow
      },
    });
    await expect(
      dispatcher.email({ subject: "s", text: "t", to: "a@b.c" }),
    ).rejects.toThrow("rejected");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(captured[0]!.kind).toBe("dispatch.email.failed");
  });

  test('actor falls back to "system" when no tenant on the message', async () => {
    const captured: Array<{ actor?: string }> = [];
    const audit: AuditLike = {
      append: async (event) => {
        captured.push(event);
      },
    };
    const dispatcher = createDispatcher({
      audit,
      email: memoryEmailAdapter(),
    });
    await dispatcher.email({ subject: "s", text: "t", to: "a@b.c" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(captured[0]!.actor).toBe("system");
  });

  test("never exposes a raw push token to audit", async () => {
    const captured: Array<{ target?: string }> = [];
    const dispatcher = createDispatcher({
      audit: {
        append: async (event) => {
          captured.push(event);
        },
      },
      push: memoryPushAdapter(),
    });
    await dispatcher.push({
      body: "Ready",
      safeTarget: "subscription-123",
      to: "raw-secret-device-token",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(captured[0]?.target).toBe("subscription-123");
    expect(JSON.stringify(captured)).not.toContain("raw-secret-device-token");
  });

  test("audit emission failures do not block dispatch", async () => {
    const broken: AuditLike = {
      append: async () => {
        throw new Error("audit down");
      },
    };
    const dispatcher = createDispatcher({
      audit: broken,
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

describe("metrics()", () => {
  test("aggregates across channels", async () => {
    const dispatcher = createDispatcher({
      email: memoryEmailAdapter(),
      push: memoryPushAdapter(),
      sms: memorySmsAdapter(),
    });
    await dispatcher.email({ subject: "s", text: "t", to: "a@b.c" });
    await dispatcher.email({ subject: "s", text: "t", to: "b@b.c" });
    await dispatcher.sms({ body: "b", to: "+1" });
    await dispatcher.push({ body: "b", to: "token" });
    const m = dispatcher.metrics();
    expect(m.sent).toBe(4);
    expect(m.failed).toBe(0);
    expect(m.byChannel.email.sent).toBe(2);
    expect(m.byChannel.sms.sent).toBe(1);
    expect(m.byChannel.push.sent).toBe(1);
  });

  test("failures do not bump sent", async () => {
    const broken: EmailAdapter = {
      name: "broken",
      send: async () => {
        throw new Error("x");
      },
    };
    const dispatcher = createDispatcher({
      email: broken,
      onError: () => {
        // swallow
      },
    });
    await dispatcher
      .email({ subject: "s", text: "t", to: "a@b.c" })
      .catch(() => {
        // noop
      });
    expect(dispatcher.metrics().sent).toBe(0);
    expect(dispatcher.metrics().failed).toBe(1);
  });
});

describe("memory adapters", () => {
  test("memoryEmailAdapter drops oldest when over max", async () => {
    const adapter = memoryEmailAdapter({ max: 2 });
    const dispatcher = createDispatcher({ email: adapter });
    await dispatcher.email({ subject: "1", text: "", to: "a@b.c" });
    await dispatcher.email({ subject: "2", text: "", to: "a@b.c" });
    await dispatcher.email({ subject: "3", text: "", to: "a@b.c" });
    expect(adapter.inspect()).toHaveLength(2);
    expect(adapter.inspect().map((m) => m.subject)).toEqual(["2", "3"]);
  });

  test("clear() empties the buffer", async () => {
    const adapter = memoryEmailAdapter();
    const dispatcher = createDispatcher({ email: adapter });
    await dispatcher.email({ subject: "s", text: "", to: "a@b.c" });
    expect(adapter.inspect()).toHaveLength(1);
    adapter.clear();
    expect(adapter.inspect()).toHaveLength(0);
  });

  test("custom idGenerator overrides the default UUID", async () => {
    let counter = 0;
    const adapter = memoryEmailAdapter({
      idGenerator: () => `msg-${++counter}`,
    });
    const dispatcher = createDispatcher({ email: adapter });
    const a = await dispatcher.email({
      subject: "a",
      text: "",
      to: "a@b.c",
    });
    const b = await dispatcher.email({
      subject: "b",
      text: "",
      to: "a@b.c",
    });
    expect(a.id).toBe("msg-1");
    expect(b.id).toBe("msg-2");
  });
});

describe("console adapters", () => {
  test("consoleEmailAdapter logs JSON to stdout", async () => {
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg: string) => captured.push(msg);
    try {
      const dispatcher = createDispatcher({
        email: consoleEmailAdapter(),
      });
      await dispatcher.email({
        subject: "hi",
        text: "there",
        to: "a@b.c",
      });
    } finally {
      console.log = original;
    }
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.channel).toBe("email");
    expect(parsed.message.subject).toBe("hi");
  });
});
