import { describe, expect, test } from "bun:test";
import {
  createPushLifecycle,
  memoryPushFanoutClaimStore,
  memoryPushSubscriptionStore,
  type PushAdapter,
} from "../src";

describe("push lifecycle", () => {
  test("targets users and topics without crossing tenants", async () => {
    const store = memoryPushSubscriptionStore();
    const sent: string[] = [];
    const adapter: PushAdapter = {
      name: "test",
      send: async (message) => {
        sent.push(message.to);
        return { at: 1, provider: "test" };
      },
    };
    let id = 0;
    const lifecycle = createPushLifecycle({
      adapterFor: () => adapter,
      idGenerator: () => `sub-${++id}`,
      store,
    });
    await lifecycle.register({
      deviceId: "phone",
      platform: "fcm",
      tenant: "a",
      token: "token-a",
      topics: ["incidents"],
      userId: "alex",
    });
    await lifecycle.register({
      deviceId: "phone",
      platform: "fcm",
      tenant: "b",
      token: "token-b",
      topics: ["incidents"],
      userId: "alex",
    });
    const result = await lifecycle.send(
      { tenant: "a", topic: "incidents" },
      { body: "Incident opened" },
    );
    expect(result.delivered).toBe(1);
    expect(sent).toEqual(["token-a"]);
  });

  test("deduplicates fanout and retires invalid registrations", async () => {
    const store = memoryPushSubscriptionStore();
    const claims = memoryPushFanoutClaimStore();
    const lifecycle = createPushLifecycle({
      adapterFor: () => ({
        name: "fcm",
        send: async () => {
          throw Object.assign(new Error("gone"), { code: "UNREGISTERED" });
        },
      }),
      claimStore: claims,
      idGenerator: () => "sub-1",
      store,
    });
    await lifecycle.register({
      deviceId: "phone",
      platform: "fcm",
      tenant: "a",
      token: "dead-token",
      userId: "alex",
    });
    const first = await lifecycle.send(
      { tenant: "a", userId: "alex" },
      { body: "Ready", idempotencyKey: "deploy-1" },
    );
    const second = await lifecycle.send(
      { subscriptionIds: ["sub-1"], tenant: "a" },
      { body: "Ready", idempotencyKey: "deploy-1" },
    );
    expect(first.retired).toBe(1);
    expect(second.targeted).toBe(0);
    expect(store.inspect()[0]?.enabled).toBe(false);
  });

  test("retries transient failures with tenant-selected adapters", async () => {
    const store = memoryPushSubscriptionStore();
    let attempts = 0;
    const lifecycle = createPushLifecycle({
      adapterFor: (subscription) => {
        expect(subscription.tenant).toBe("tenant-a");
        return {
          name: "apns",
          send: async () => {
            attempts += 1;
            if (attempts < 3)
              throw Object.assign(new Error("busy"), { status: 503 });
            return { at: 1, id: "provider-id", provider: "apns" };
          },
        };
      },
      retryDelay: async () => {},
      store,
    });
    await lifecycle.register({
      deviceId: "iphone",
      platform: "apns",
      tenant: "tenant-a",
      token: "token",
      userId: "user",
    });
    const result = await lifecycle.send(
      { tenant: "tenant-a", userId: "user" },
      { body: "Ready" },
    );
    expect(result.outcomes[0]).toMatchObject({
      attempts: 3,
      providerMessageId: "provider-id",
      status: "delivered",
    });
  });
});
