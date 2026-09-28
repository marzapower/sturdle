import { JobRegistry } from "@sturdle/engine";

export type EmailSendPayload = { to: string; subject: string };

// Registering is a module side effect: import this file once (lib/engine.ts does) and the
// engine knows the job. `event` is the code you enqueue with; `step.run` results are persisted,
// so a retry after a crash replays completed steps instead of re-running them.
JobRegistry.register<EmailSendPayload>({
  name: "Send email",
  event: "email/send",
  func: async (ctx) => {
    const { to, subject } = ctx.event.data;

    const messageId = await ctx.step.run("send", async () => {
      // Replace with your email provider. Anything returned here is memoized.
      console.log(`[email/send] sending "${subject}" to ${to}`);
      return `msg_${Date.now().toString(36)}`;
    });

    await ctx.step.run("record", async () => {
      console.log(`[email/send] recorded ${messageId}`);
    });

    return { messageId };
  },
});
