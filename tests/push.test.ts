import { describe, expect, test } from "bun:test";
import {
  createPushLifecycle,
  memoryPushFanoutClaimStore,
  memoryPushSubscriptionStore,
  PushInstallationOwnershipError,
  type PushAdapter,
} from "../src";

describe("push lifecycle", () => {
  test("owns server-issued installation rotation and removal", async () => {
    const store = memoryPushSubscriptionStore();
    let id = 0;
    const lifecycle = createPushLifecycle({
      adapterFor: () => ({
        name: "test",
        send: async () => ({ at: 1, provider: "test" }),
      }),
      idGenerator: () => `server-${++id}`,
      store,
    });
    const created = await lifecycle.registerInstallation({
      platform: "fcm",
      tenant: "tenant-a",
      token: "token-1",
      topics: ["incidents"],
      userId: "user-1",
    });
    expect(created.installationId).toBe("server-1");
    expect(store.inspect()).toEqual([
      expect.objectContaining({
        deviceId: "server-1",
        token: "token-1",
        userId: "user-1",
      }),
    ]);

    await lifecycle.registerInstallation({
      installationId: created.installationId,
      platform: "fcm",
      tenant: "tenant-a",
      token: "token-rotated",
      userId: "user-1",
    });
    expect(store.inspect()).toHaveLength(1);
    expect(store.inspect()[0]).toMatchObject({
      deviceId: "server-1",
      token: "token-rotated",
    });
    await expect(
      lifecycle.registerInstallation({
        installationId: created.installationId,
        platform: "fcm",
        tenant: "tenant-a",
        token: "attacker-token",
        userId: "user-2",
      }),
    ).rejects.toBeInstanceOf(PushInstallationOwnershipError);
    await expect(
      lifecycle.removeInstallation({
        installationId: created.installationId,
        tenant: "tenant-a",
        userId: "user-2",
      }),
    ).rejects.toBeInstanceOf(PushInstallationOwnershipError);

    await lifecycle.removeInstallation({
      installationId: created.installationId,
      tenant: "tenant-a",
      userId: "user-1",
    });
    expect(store.inspect()).toEqual([]);
  });

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
