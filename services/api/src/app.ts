import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { ZodError } from "zod";
import { router, type Deps } from "./context.js";
import { gameRoutes } from "./routes/games.js";
import { socialRoutes } from "./routes/social.js";
import { storeRoutes } from "./routes/store.js";
import { assetRoutes } from "./routes/assets.js";
import { generationRoutes } from "./routes/generations.js";
import { uploadRoutes } from "./routes/uploads.js";
import { userRoutes } from "./routes/users.js";
import { workerRoutes } from "./routes/worker.js";
import { insightsRoutes } from "./routes/insights.js";
import { leaderboardRoutes } from "./routes/leaderboards.js";
import { groupRoutes } from "./routes/groups.js";

export function createApp(deps: Deps, opts: { log?: boolean; corsOrigins?: string[] } = {}) {
  const app = router();
  if (opts.log) app.use(logger());
  // The engine runs in browsers/WebViews on other origins and calls the API with a bearer token
  // (no cookies), so permissive CORS is safe; restrict via CORS_ORIGINS in production.
  app.use("*", cors({
    origin: opts.corsOrigins?.length ? opts.corsOrigins : "*",
    allowHeaders: ["authorization", "content-type", "last-event-id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }));

  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/", userRoutes(deps));
  app.route("/", gameRoutes(deps));
  app.route("/", uploadRoutes(deps));
  app.route("/", generationRoutes(deps));
  app.route("/", workerRoutes(deps));
  app.route("/", storeRoutes(deps));
  app.route("/", assetRoutes(deps));
  app.route("/", socialRoutes(deps));
  app.route("/", insightsRoutes(deps));
  app.route("/", leaderboardRoutes(deps));
  app.route("/", groupRoutes(deps));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const extra = err.cause && typeof err.cause === "object" ? err.cause : {};
      return c.json({ error: err.message, ...extra }, err.status);
    }
    if (err instanceof ZodError) return c.json({ error: err.issues.map((i) => i.message).join("; ") }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
