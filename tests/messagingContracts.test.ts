import { describe, expect, test } from "bun:test";
import type {
  MessagingAdapter,
  MessagingDeliveryEvent,
  MessagingRegistrationCapability,
  MessagingTransport,
} from "../src/index";

declare module "../src/index" {
  interface MessagingTransportRegistry {
    viber: { family: "ott" };
  }
}

describe("messaging ecosystem contracts", () => {
  test("adapter packages can add a transport without changing core", async () => {
    const transport: MessagingTransport = "viber";
    const adapter: MessagingAdapter = {
      name: "example",
      send: async (message) => ({
        at: 1,
        delivery: {
          actualTransport: transport,
          attempts: [
            {
              actualTransport: transport,
              providerMessageId: "message-1",
              route: "primary",
              status: "accepted",
              transport,
            },
          ],
          requestedTransport: message.to.transport,
        },
        id: "message-1",
        provider: "example",
      }),
    };

    const result = await adapter.send({
      content: { kind: "text", text: "hello" },
      to: { address: "recipient", transport },
    });
    expect(result.delivery.actualTransport).toBe("viber");
  });

  test("normalizes lifecycle, economics, and carrier metadata", () => {
    const event: MessagingDeliveryEvent = {
      actualTransport: "sms",
      economics: { currency: "EUR", price: "0.0333", segments: 2 },
      errors: [],
      eventId: "event-1",
      kind: "delivery",
      messageId: "message-1",
      networkCode: "12345",
      occurredAt: 1,
      provider: "example",
      providerStatus: "delivered",
      status: "delivered",
    };
    expect(event.economics?.segments).toBe(2);
  });

  test("supports provider-shaped registration inputs with common reports", async () => {
    const registration: MessagingRegistrationCapability<{
      campaignId: string;
    }> = {
      inspect: async ({ campaignId }) => ({
        checks: [
          {
            detail: `Campaign ${campaignId} is approved`,
            id: "campaign",
            status: "pass",
          },
        ],
        ready: true,
      }),
    };
    expect(
      (await registration.inspect({ campaignId: "campaign-1" })).ready,
    ).toBe(true);
  });
});
