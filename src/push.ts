import type { DispatchResult, PushAdapter, PushMessage } from "./index";

export type PushPlatform = "apns" | "fcm";

export type PushSubscription = {
  createdAt: number;
  deviceId: string;
  enabled: boolean;
  id: string;
  lastSeenAt: number;
  locale?: string;
  platform: PushPlatform;
  tenant: string;
  token: string;
  topics: ReadonlyArray<string>;
  updatedAt: number;
  userId: string;
};

export type RegisterPushSubscriptionInput = {
  deviceId: string;
  id?: string;
  locale?: string;
  platform: PushPlatform;
  tenant: string;
  token: string;
  topics?: ReadonlyArray<string>;
  userId: string;
};

export type PushSubscriptionQuery = {
  deviceId?: string;
  ids?: ReadonlyArray<string>;
  platform?: PushPlatform;
  tenant: string;
  topic?: string;
  userId?: string;
};

export type PushSubscriptionStore = {
  disable: (input: {
    id: string;
    reason: string;
    tenant: string;
  }) => Promise<void>;
  list: (
    query: PushSubscriptionQuery,
  ) => Promise<ReadonlyArray<PushSubscription>>;
  remove: (input: { id: string; tenant: string }) => Promise<void>;
  upsert: (subscription: PushSubscription) => Promise<PushSubscription>;
};

export type PushFanoutClaim =
  | { disposition: "claimed"; token: string }
  | { disposition: "completed" | "in-flight" | "indeterminate" };

export type PushFanoutClaimStore = {
  claim: (key: string) => Promise<PushFanoutClaim>;
  complete: (key: string, token: string) => Promise<void>;
  fail: (key: string, token: string, reason?: string) => Promise<void>;
};

export type PushTarget =
  | { deviceId: string; tenant: string; userId?: string }
  | { subscriptionIds: ReadonlyArray<string>; tenant: string }
  | { tenant: string; topic: string }
  | { tenant: string; userId: string };

export type PushFanoutOutcome = {
  attempts: number;
  provider?: string;
  providerMessageId?: string;
  status: "delivered" | "failed" | "indeterminate" | "retired" | "skipped";
  subscriptionId: string;
  error?: unknown;
};

export type PushFanoutResult = {
  delivered: number;
  failed: number;
  indeterminate: number;
  outcomes: ReadonlyArray<PushFanoutOutcome>;
  retired: number;
  skipped: number;
  targeted: number;
};

export type CreatePushLifecycleOptions = {
  adapterFor: (
    subscription: PushSubscription,
  ) => Promise<PushAdapter> | PushAdapter;
  claimStore?: PushFanoutClaimStore;
  clock?: () => number;
  concurrency?: number;
  idGenerator?: () => string;
  isInvalidTokenError?: (error: unknown, platform: PushPlatform) => boolean;
  isRetryableError?: (error: unknown) => boolean;
  maxAttempts?: number;
  retryDelay?: (attempt: number) => Promise<void>;
  store: PushSubscriptionStore;
};

const nonEmpty = (name: string, value: string) => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`[dispatch] ${name} is required`);
  return normalized;
};

const normalizedTopics = (topics: ReadonlyArray<string> | undefined) =>
  [...new Set((topics ?? []).map((topic) => nonEmpty("topic", topic)))].sort();

const statusOf = (error: unknown) =>
  typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;

const codeOf = (error: unknown) => {
  if (typeof error !== "object" || error === null) return undefined;
  for (const key of ["code", "reason", "name"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string") return value.toUpperCase();
  }
  return undefined;
};

const defaultInvalidTokenError = (error: unknown) => {
  const code = codeOf(error);
  return (
    statusOf(error) === 410 ||
    code === "UNREGISTERED" ||
    code === "BADDEVICETOKEN" ||
    code === "DEVICEUNREGISTERED" ||
    code === "INVALIDREGISTRATION"
  );
};

const defaultRetryableError = (error: unknown) => {
  const status = statusOf(error);
  return (
    status === 408 || status === 429 || (status !== undefined && status >= 500)
  );
};

const queryForTarget = (target: PushTarget): PushSubscriptionQuery => {
  if ("subscriptionIds" in target)
    return { ids: target.subscriptionIds, tenant: target.tenant };
  if ("topic" in target) return { tenant: target.tenant, topic: target.topic };
  if ("deviceId" in target)
    return {
      deviceId: target.deviceId,
      tenant: target.tenant,
      ...(target.userId ? { userId: target.userId } : {}),
    };
  return { tenant: target.tenant, userId: target.userId };
};

const fanoutMessage = (
  message: Omit<PushMessage, "safeTarget" | "tenant" | "to">,
  subscription: PushSubscription,
): PushMessage => ({
  ...message,
  safeTarget: subscription.id,
  tenant: subscription.tenant,
  to: subscription.token,
});

export const createPushLifecycle = (options: CreatePushLifecycleOptions) => {
  const clock = options.clock ?? Date.now;
  const idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  const concurrency = options.concurrency ?? 10;
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("[dispatch] push concurrency must be a positive integer");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    throw new Error("[dispatch] push maxAttempts must be a positive integer");
  const retryDelay =
    options.retryDelay ??
    ((attempt: number) =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(1_000, 100 * 2 ** (attempt - 1))),
      ));
  const invalidToken = options.isInvalidTokenError ?? defaultInvalidTokenError;
  const retryable = options.isRetryableError ?? defaultRetryableError;

  const register = async (
    input: RegisterPushSubscriptionInput,
  ): Promise<PushSubscription> => {
    const now = clock();
    return options.store.upsert({
      createdAt: now,
      deviceId: nonEmpty("deviceId", input.deviceId),
      enabled: true,
      id: input.id ? nonEmpty("id", input.id) : idGenerator(),
      lastSeenAt: now,
      ...(input.locale ? { locale: input.locale } : {}),
      platform: input.platform,
      tenant: nonEmpty("tenant", input.tenant),
      token: nonEmpty("token", input.token),
      topics: normalizedTopics(input.topics),
      updatedAt: now,
      userId: nonEmpty("userId", input.userId),
    });
  };

  const sendOne = async (
    subscription: PushSubscription,
    message: Omit<PushMessage, "safeTarget" | "tenant" | "to">,
  ): Promise<PushFanoutOutcome> => {
    const claimKey = message.idempotencyKey
      ? `${subscription.tenant}:${message.idempotencyKey}:${subscription.id}`
      : undefined;
    const claim =
      claimKey && options.claimStore
        ? await options.claimStore.claim(claimKey)
        : undefined;
    if (claim && claim.disposition !== "claimed")
      return {
        attempts: 0,
        status:
          claim.disposition === "indeterminate" ? "indeterminate" : "skipped",
        subscriptionId: subscription.id,
      };
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const adapter = await options.adapterFor(subscription);
        const result: DispatchResult = await adapter.send(
          fanoutMessage(message, subscription),
        );
        if (claimKey && options.claimStore && claim?.disposition === "claimed")
          await options.claimStore.complete(claimKey, claim.token);
        return {
          attempts: attempt,
          provider: result.provider,
          ...(result.id ? { providerMessageId: result.id } : {}),
          status: "delivered",
          subscriptionId: subscription.id,
        };
      } catch (error) {
        lastError = error;
        if (invalidToken(error, subscription.platform)) {
          await options.store.disable({
            id: subscription.id,
            reason: codeOf(error) ?? "invalid-token",
            tenant: subscription.tenant,
          });
          if (
            claimKey &&
            options.claimStore &&
            claim?.disposition === "claimed"
          )
            await options.claimStore.complete(claimKey, claim.token);
          return {
            attempts: attempt,
            error,
            status: "retired",
            subscriptionId: subscription.id,
          };
        }
        if (attempt < maxAttempts && retryable(error)) {
          await retryDelay(attempt);
          continue;
        }
        break;
      }
    }
    if (claimKey && options.claimStore && claim?.disposition === "claimed")
      await options.claimStore.fail(
        claimKey,
        claim.token,
        lastError instanceof Error ? lastError.message : String(lastError),
      );
    return {
      attempts: maxAttempts,
      error: lastError,
      status: "failed",
      subscriptionId: subscription.id,
    };
  };

  const send = async (
    target: PushTarget,
    message: Omit<PushMessage, "safeTarget" | "tenant" | "to">,
  ): Promise<PushFanoutResult> => {
    const subscriptions = (
      await options.store.list(queryForTarget(target))
    ).filter((subscription) => subscription.enabled);
    const outcomes: PushFanoutOutcome[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < subscriptions.length) {
        const subscription = subscriptions[cursor++];
        if (subscription) outcomes.push(await sendOne(subscription, message));
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, subscriptions.length) },
        worker,
      ),
    );
    return {
      delivered: outcomes.filter((item) => item.status === "delivered").length,
      failed: outcomes.filter((item) => item.status === "failed").length,
      indeterminate: outcomes.filter((item) => item.status === "indeterminate")
        .length,
      outcomes,
      retired: outcomes.filter((item) => item.status === "retired").length,
      skipped: outcomes.filter((item) => item.status === "skipped").length,
      targeted: subscriptions.length,
    };
  };

  return {
    register,
    remove: (input: { id: string; tenant: string }) =>
      options.store.remove(input),
    send,
  };
};

export const memoryPushSubscriptionStore = (): PushSubscriptionStore & {
  inspect: () => ReadonlyArray<PushSubscription>;
} => {
  const records = new Map<string, PushSubscription>();
  const key = (tenant: string, id: string) => `${tenant}\u0000${id}`;
  return {
    disable: async ({ id, tenant }) => {
      const existing = records.get(key(tenant, id));
      if (existing)
        records.set(key(tenant, id), {
          ...existing,
          enabled: false,
          updatedAt: Date.now(),
        });
    },
    inspect: () => [...records.values()],
    list: async (query) =>
      [...records.values()].filter(
        (item) =>
          item.tenant === query.tenant &&
          (!query.ids || query.ids.includes(item.id)) &&
          (!query.userId || item.userId === query.userId) &&
          (!query.deviceId || item.deviceId === query.deviceId) &&
          (!query.platform || item.platform === query.platform) &&
          (!query.topic || item.topics.includes(query.topic)),
      ),
    remove: async ({ id, tenant }) => {
      records.delete(key(tenant, id));
    },
    upsert: async (subscription) => {
      const duplicate = [...records.values()].find(
        (item) =>
          item.tenant === subscription.tenant &&
          item.platform === subscription.platform &&
          item.token === subscription.token,
      );
      const existing =
        duplicate ?? records.get(key(subscription.tenant, subscription.id));
      const next = existing
        ? {
            ...subscription,
            createdAt: existing.createdAt,
            id: existing.id,
          }
        : subscription;
      if (duplicate) records.delete(key(duplicate.tenant, duplicate.id));
      records.set(key(next.tenant, next.id), next);
      return next;
    },
  };
};

export const memoryPushFanoutClaimStore = (): PushFanoutClaimStore => {
  const claims = new Map<
    string,
    {
      reason?: string;
      state: "claimed" | "complete" | "indeterminate";
      token?: string;
    }
  >();
  return {
    claim: async (key) => {
      const existing = claims.get(key);
      if (existing?.state === "complete") return { disposition: "completed" };
      if (existing?.state === "indeterminate")
        return { disposition: "indeterminate" };
      if (existing?.state === "claimed") return { disposition: "in-flight" };
      const token = crypto.randomUUID();
      claims.set(key, { state: "claimed", token });
      return { disposition: "claimed", token };
    },
    complete: async (key, token) => {
      if (claims.get(key)?.token !== token)
        throw new Error("[dispatch] invalid push fanout fencing token");
      claims.set(key, { state: "complete" });
    },
    fail: async (key, token, reason) => {
      if (claims.get(key)?.token !== token)
        throw new Error("[dispatch] invalid push fanout fencing token");
      claims.set(key, { reason, state: "indeterminate" });
    },
  };
};
