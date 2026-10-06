// Cloudflare Worker entry point. Only the default export is used by the runtime; the logic lives in app.ts so it
// can be tested without Wrangler.
import { fetchHandler, processDemoReminders } from "./app.ts";
import type { Env } from "./store.ts";

interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }
interface ScheduledControllerLike { cron: string }

export default {
  fetch(request: Request, env: Env, _context: ExecutionContextLike) {
    return fetchHandler(request, env);
  },
  scheduled(_controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike) {
    context.waitUntil(processDemoReminders(env).catch(() => {
      console.error(JSON.stringify({ event: "reminder_job_failed" }));
    }));
  },
};
