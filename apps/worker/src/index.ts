// Cloudflare Worker entry point. Only the default export is used by the runtime; the logic lives in app.ts so it
// can be tested without Wrangler.
import { fetchHandler, purgeDemoData } from "./app.ts";
import type { Env, ExecutionContextLike } from "./store.ts";

interface ScheduledControllerLike { cron: string }

export default {
  fetch(request: Request, env: Env, context: ExecutionContextLike) {
    return fetchHandler(request, env, context);
  },
  scheduled(_controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike) {
    context.waitUntil(purgeDemoData(env).catch(() => {
      console.error(JSON.stringify({ event: "purge_job_failed" }));
    }));
  },
};
