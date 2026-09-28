// Next.js calls `register` once when the server boots. Starting the worker here means every
// `next start` / `next dev` process polls for jobs for as long as it lives; nothing runs when
// no process is up, which is why this needs a long-running Node host (see the README).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getEngine } = await import("./lib/engine");
  await getEngine();
}
