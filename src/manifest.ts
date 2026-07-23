import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { Dispatcher, DispatcherOptions } from "./index";

const tool = toolFactory<Dispatcher>();

/* Serializable subset of DispatcherOptions: defaultFrom only. The channel
 * adapters (email/sms/push) are instance-valued → slots; onError /
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
          sms: Type.Optional(
            Type.String({
              description:
                "The phone number texts are sent from, in international format.",
              examples: ["+12025550100"],
              title: "Default text-message number",
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
    sms: {
      configPath: "sms",
      contract: "dispatch/sms-adapter",
      description: "Who delivers your text messages",
      known: ["@absolutejs/dispatch-twilio"],
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
        "Sent/failed counters per channel (email, sms, push) since the server started.",
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
    send_sms: tool.runtime({
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
        const result = await dispatcher.sms(input);

        return `sent via ${result.provider}${result.id === undefined ? "" : ` (id ${result.id})`}`;
      },
      input: Type.Object({
        body: Type.String({ minLength: 1 }),
        to: Type.String({ pattern: "^\\+[0-9]{7,15}$" }),
      }),
    }),
  },
  wiring: [
    {
      id: "default",
      server: {
        code: "const dispatcher = createDispatcher({ email: ${slot.email}, push: ${slot.push}, sms: ${slot.sms}, ...${settings} });",
        imports: [
          { from: "@absolutejs/dispatch", names: ["createDispatcher"] },
        ],
        placement: "module-scope",
      },
      title: "Create the dispatcher",
    },
  ],
});
