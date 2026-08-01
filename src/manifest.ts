import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { Dispatcher, DispatcherOptions } from "./index";

const tool = toolFactory<Dispatcher>();

/* Serializable subset of DispatcherOptions: defaultFrom only. The channel
 * adapters (email/messaging/push) are instance-valued → slots; onError /
 * tracerProvider / audit / clock are function-or-instance-valued → wiring
 * concerns, never settings. */
export const manifest = defineManifest<DispatcherOptions, Dispatcher>()({
  contract: 2,
  identity: {
    accent: "#38bdf8",
    category: "messaging",
    description:
      "One `createDispatcher()` for transactional email, SMS, and push notifications. Channels are pluggable vendor adapters (`@absolutejs/dispatch-*`); every send returns a uniform result and feeds the same metrics surface.",
    docsUrl: "https://github.com/absolutejs/dispatch",
    name: "@absolutejs/dispatch",
    tagline: "Send email, texts, and push notifications from your site.",
  },
  settings: Type.Object({
    defaultFrom: Type.Optional(
      Type.Object(
        {
          email: Type.Optional(
            Type.String({
              description:
                "Used when a message doesn’t name a sender. Must be a sender your email provider has verified.",
              examples: ["hello@yoursite.com"],
              format: "email",
              title: "Default email sender",
            }),
          ),
          messaging: Type.Optional(
            Type.Object({
              address: Type.String({
                description: "Default provider-approved sender address.",
                examples: ["+12025550100"],
              }),
              transport: Type.Union([
                Type.Literal("sms"),
                Type.Literal("mms"),
                Type.Literal("rcs"),
                Type.Literal("whatsapp"),
              ]),
            }),
          ),
        },
        { title: "Default senders" },
      ),
    ),
  }),
  slots: {
    email: {
      configPath: "email",
      contract: "dispatch/email-adapter",
      description: "Who delivers your email",
      known: ["@absolutejs/dispatch-resend", "@absolutejs/dispatch-postmark"],
    },
    push: {
      configPath: "push",
      contract: "dispatch/push-adapter",
      description: "Who delivers your push notifications",
    },
    messaging: {
      configPath: "messaging",
      contract: "dispatch/messaging-adapter",
      description: "Who delivers carrier and rich-channel messages",
      known: [
        "@absolutejs/dispatch-sinch",
        "@absolutejs/dispatch-telnyx",
        "@absolutejs/dispatch-twilio",
        "@absolutejs/dispatch-vonage",
      ],
    },
  },
  tools: {
    messaging_stats: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "authenticated",
        effects: ["read"],
        requiredScopes: ["messaging:read"],
      },
      description:
        "Sent/failed counters per channel (email, messaging, push) since the server started.",
      handler: (_input, dispatcher) => JSON.stringify(dispatcher.metrics()),
      input: Type.Object({}),
    }),
    send_email: tool.runtime({
      annotations: { idempotentHint: true, openWorldHint: true },
      authorization: {
        approval: "policy",
        audience: "authenticated",
        destinationFields: ["to"],
        effects: ["send", "external-network"],
        idempotency: { mode: "host" },
        requiredScopes: ["messaging:send"],
        reversible: false,
      },
      description:
        "Send a transactional email through the configured provider. Reports the provider and tracking id.",
      handler: async (input, dispatcher) => {
        const result = await dispatcher.email(input);

        return `sent via ${result.provider}${result.id === undefined ? "" : ` (id ${result.id})`}`;
      },
      input: Type.Object({
        subject: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1 }),
        to: Type.String({ format: "email" }),
      }),
    }),
    send_messaging: tool.runtime({
      annotations: { idempotentHint: true, openWorldHint: true },
      authorization: {
        approval: "policy",
        audience: "authenticated",
        destinationFields: ["to"],
        effects: ["send", "external-network"],
        idempotency: { mode: "host" },
        requiredScopes: ["messaging:send"],
        reversible: false,
      },
      description:
        "Send a text message through the configured provider. `to` is an international-format phone number.",
      handler: async (input, dispatcher) => {
        const result = await dispatcher.messaging({
          content: { kind: "text", text: input.text },
          to: { address: input.to, transport: input.transport },
        });

        return `sent via ${result.provider}${result.id === undefined ? "" : ` (id ${result.id})`}`;
      },
      input: Type.Object({
        text: Type.String({ minLength: 1 }),
        to: Type.String({ pattern: "^\\+[0-9]{7,15}$" }),
        transport: Type.Union([Type.Literal("sms"), Type.Literal("mms")]),
      }),
    }),
  },
  wiring: [
    {
      id: "default",
      server: {
        code: "const dispatcher = createDispatcher({ email: ${slot.email}, messaging: ${slot.messaging}, push: ${slot.push}, ...${settings} });",
        imports: [
          { from: "@absolutejs/dispatch", names: ["createDispatcher"] },
        ],
        placement: "module-scope",
      },
      title: "Create the dispatcher",
    },
  ],
});
