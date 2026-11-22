import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { env, isTest } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { db } from "./lib/db.js";
import { uuid } from "./lib/crypto.js";
import { AppError } from "./lib/errors.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { globalLimiter } from "./middleware/rateLimit.js";
import { loadModules } from "./modules/index.js";
import { buildOpenApi, routeCount } from "./docs/registry.js";
import filesModule from "./modules/files/handlers.js";

const allowedOrigins = env.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** CSRF defense for cookie-authenticated mutations: Origin must be an allowed front-end origin. */
function originCheck(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const usesCookie =
    !req.get("authorization") && !req.get("x-api-key") && req.cookies?.tr_at;
  const origin = req.get("origin");
  if (
    usesCookie &&
    origin &&
    !allowedOrigins.includes(origin) &&
    origin !== env.APP_URL
  )
    throw new AppError(
      403,
      "CSRF_ORIGIN_REJECTED",
      "Request origin not allowed",
    );
  next();
}

export async function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    req.id = req.get("x-request-id") || uuid();
    res.setHeader("X-Request-Id", req.id);
    next();
  });

  if (!isTest)
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => req.id,
        autoLogging: { ignore: (req) => req.url === "/health" },
      }),
    );
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      exposedHeaders: ["X-Request-Id", "RateLimit-Remaining", "Retry-After"],
    }),
  );
  app.use(cookieParser());

  // Signed-URL file endpoints need the raw body → mounted before the JSON parser.
  app.use("/api/v1/files", filesModule.router);

  // Keep the raw body for inbound provider webhooks (Stripe/GitHub/Slack signature verification).
  app.use(
    express.json({
      limit: "20mb",
      verify: (req, _res, buf) => {
        if (req.originalUrl.startsWith("/api/v1/webhooks/"))
          req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use("/api/v1", globalLimiter, originCheck);

  app.get("/health", async (_req, res) => {
    let database = "ok";
    try {
      await db.one("SELECT 1 AS ok");
    } catch {
      database = "error";
    }
    res
      .status(database === "ok" ? 200 : 503)
      .json({
        status: database === "ok" ? "ok" : "degraded",
        database,
        driver: db.kind,
        time: new Date().toISOString(),
      });
  });

  const routers = await loadModules();
  for (const r of routers) app.use(`/api/v1${r.prefix}`, r.router);

  const spec = buildOpenApi();
  app.get("/api/openapi.json", (_req, res) => res.json(spec));
  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(spec, { customSiteTitle: "Tracker API docs" }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  logger.info(
    { modules: routers.length, routes: routeCount() },
    "routes registered",
  );
  return app;
}
