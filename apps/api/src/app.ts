import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";

import { createAgentRegistry } from "./agents/index.js";
import type { AgentRegistry } from "./agents/registry.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createPrismaClient } from "./db/client.js";
import { GitHubClient } from "./github/client.js";
import { registerGithubRoutes } from "./http/github-routes.js";
import { registerRoutes } from "./http/routes.js";
import { registerSecurityRoutes } from "./http/security-routes.js";
import { RunEventBus } from "./runs/event-bus.js";
import { RunService, type GitHubIntegration } from "./runs/run-service.js";
import { RunStore } from "./runs/run-store.js";
import { SecurityScanner } from "./security/scanner.js";
import { WorktreeService } from "./worktrees/worktree-service.js";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface BuildAppOptions {
  /** Enable request logging. Disabled by default in tests. */
  logger?: boolean;
  /** Override the configuration, mainly for tests. */
  config?: AppConfig;
  /** Override the agent registry, mainly for tests. */
  agents?: AgentRegistry;
  /** Override the worktree service, mainly for tests. */
  worktreeService?: WorktreeService;
  /** Override GitHub wiring: null disables it, undefined uses configuration. */
  githubClient?: GitHubClient | null;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const prisma = createPrismaClient(config.databaseUrl);
  const store = new RunStore(prisma);
  const events = new RunEventBus();
  const agents =
    options.agents ?? createAgentRegistry(config.llm, config.agent);

  const app = Fastify({
    logger: options.logger ?? true,
  });

  app.setErrorHandler((error, request, reply) => {
    let statusCode = 500;
    let message = "An unexpected error occurred.";

    if (error instanceof Error) {
      const maybeStatusCode = (error as { statusCode?: number }).statusCode;

      if (typeof maybeStatusCode === "number") {
        statusCode = maybeStatusCode;
      }

      if (statusCode < 500) {
        message = error.message;
      }
    }

    if (statusCode >= 500) {
      request.log.error({ err: error }, "Unhandled request error");
    } else {
      request.log.warn({ err: error }, "Request rejected");
    }

    return reply.status(statusCode).send({
      success: false,
      error: message,
    });
  });

  const worktreesRoot = config.worktrees.root
    ? path.resolve(REPO_ROOT, config.worktrees.root)
    : path.resolve(REPO_ROOT, ".taskfleet/worktrees");

  const worktreeService =
    options.worktreeService ??
    new WorktreeService({
      repoRoot: REPO_ROOT,
      worktreesRoot,
      authorName: config.git.authorName,
      authorEmail: config.git.authorEmail,
    });

  const configuredGithub: GitHubIntegration | null =
    config.github.token && config.github.repository
      ? {
          client: new GitHubClient({
            token: config.github.token,
            repository: config.github.repository,
          }),
          repository: config.github.repository,
          baseBranch: config.github.baseBranch,
          ...(config.github.remoteUrl
            ? { remoteUrl: config.github.remoteUrl }
            : {}),
        }
      : null;

  const github =
    options.githubClient === undefined
      ? configuredGithub
      : options.githubClient === null
        ? null
        : config.github.repository
          ? {
              client: options.githubClient,
              repository: config.github.repository,
              baseBranch: config.github.baseBranch,
              ...(config.github.remoteUrl
                ? { remoteUrl: config.github.remoteUrl }
                : {}),
            }
          : null;

  // Rebuild the service now that the worktree and GitHub dependencies exist.
  const lifecycle = new RunService({
    store,
    agents,
    events,
    logger: app.log,
    config,
    worktrees: {
      enabled: config.worktrees.enabled,
      service: worktreeService,
    },
    github,
  });

  const apiDeps = {
    agents,
    store,
    events,
    runService: lifecycle,
    worktrees: {
      enabled: config.worktrees.enabled,
      service: worktreeService,
    },
    integrations: {
      llm: {
        provider: config.llm.provider,
        model: config.llm.model ?? null,
        configured:
          config.llm.provider === "stub" || Boolean(config.llm.apiKey),
        toolCalling: config.llm.provider !== "stub",
        live: config.llm.provider !== "stub",
      },
      github: {
        repository: config.github.repository ?? null,
        tokenConfigured: Boolean(config.github.token),
        webhookConfigured: Boolean(config.github.webhookSecret),
        prCreation: Boolean(github),
        baseBranch: config.github.baseBranch,
      },
      worktrees: {
        enabled: config.worktrees.enabled,
        root: worktreesRoot,
      },
      security: {
        enabled: config.security.enabled,
      },
    },
  };

  const securityDeps = {
    enabled: config.security.enabled,
    scanner: new SecurityScanner({ root: REPO_ROOT }),
  };

  // Canonical routes at the root (backwards compatible) and the same API
  // under /api so the SPA can use one base URL in dev and production.
  app.register(async (instance) => {
    registerRoutes(instance, apiDeps);
  });

  app.register(
    async (instance) => {
      registerRoutes(instance, apiDeps);
    },
    { prefix: "/api" }
  );

  app.register(
    async (instance) => {
      registerSecurityRoutes(instance, securityDeps);
    },
    { prefix: "/security" }
  );

  app.register(
    async (instance) => {
      registerSecurityRoutes(instance, securityDeps);
    },
    { prefix: "/api/security" }
  );

  // GitHub webhooks need the raw body for HMAC verification, so the parser is
  // scoped to this plugin instead of replacing the global JSON parser.
  app.register(
    async (instance) => {
      instance.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (request: FastifyRequest, body: string, done) => {
          (request as FastifyRequest & { rawBody?: string }).rawBody = body;

          try {
            done(null, JSON.parse(body) as unknown);
          } catch (error: unknown) {
            done(
              error instanceof Error ? error : new Error("Invalid JSON body"),
              undefined
            );
          }
        }
      );

      registerGithubRoutes(instance, {
        store,
        ...(config.github.webhookSecret
          ? { secret: config.github.webhookSecret }
          : {}),
      });
    },
    { prefix: "/webhooks" }
  );

  // Serve the built dashboard when it exists (single-process demo / Docker).
  if (existsSync(WEB_DIST)) {
    app.register(fastifyStatic, {
      root: WEB_DIST,
      wildcard: false,
      index: false,
    });

    app.setNotFoundHandler((request, reply) => {
      const wantsHtml =
        request.headers.accept?.includes("text/html") ?? false;

      if (
        request.method === "GET" &&
        wantsHtml &&
        !request.url.startsWith("/api")
      ) {
        return reply.sendFile("index.html");
      }

      return reply.status(404).send({ success: false, error: "Not found." });
    });
  }

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
}
