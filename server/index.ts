import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import rateLimit from "express-rate-limit";
import { purgeStaleIonianLocationCache } from "./cache-db";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Follow-up chat carries the complete text-only weather analysis, separately
// bounded and validated by its route. Keep the default limit on other routes.
app.use("/api/chat", express.json({ limit: "512kb" }));
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

app.set("trust proxy", 1);

const chatRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Anfragen. Bitte warte kurz und versuche es erneut." },
});

const uploadRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Upload-Anfragen. Bitte warte kurz und versuche es erneut." },
});

const CUSTOM_DOMAIN = "aiwindy.schorr.wien";
const REPLIT_DOMAINS = (process.env.REPLIT_DOMAINS || "").split(",").map(d => d.trim()).filter(Boolean);

app.use((req, res, next) => {
  const host = (req.headers.host || "").split(":")[0];
  const isReplitDomain = REPLIT_DOMAINS.some(d => host === d || host.endsWith(".replit.app") || host.endsWith(".replit.dev"));
  if (process.env.NODE_ENV === "production" && isReplitDomain && host !== CUSTOM_DOMAIN) {
    return res.redirect(301, `https://${CUSTOM_DOMAIN}${req.originalUrl}`);
  }
  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  app.use("/api/chat", chatRateLimit);
  app.use("/api/upload", uploadRateLimit);

  if (process.env.NODE_ENV === "production") {
    const purgedCount = await purgeStaleIonianLocationCache();
    log(`[production-maintenance] removed ${purgedCount} stale Ionian location cache entr${purgedCount === 1 ? "y" : "ies"}`);
  }

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
