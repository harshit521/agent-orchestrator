import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

import type {
  CreatedRepository,
} from "../src/github/client.js";
import { GitHubError } from "../src/github/client.js";
import type { GitHubIntegration } from "../src/github/integration.js";
import {
  RepositoryBootstrapError,
  RepositoryService,
  type RepositoryCreator,
} from "../src/repositories/repository-service.js";
import { WorktreeService } from "../src/worktrees/worktree-service.js";
import { createTestDatabase, testConfig, type TestDatabase } from "./helpers.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tempWorkspace(): { base: string; repoRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), "taskfleet-repository-"));
  return { base, repoRoot: path.join(base, "workspace") };
}

function createdRepository(overrides: Partial<CreatedRepository> = {}): CreatedRepository {
  return {
    name: "demo",
    fullName: "acme/demo",
    url: "https://github.com/acme/demo",
    cloneUrl: "https://github.com/acme/demo.git",
    sshUrl: "git@github.com:acme/demo.git",
    defaultBranch: "main",
    private: true,
    owner: "acme",
    ...overrides,
  };
}

const scratchDirectories: string[] = [];

afterEach(async () => {
  while (scratchDirectories.length > 0) {
    const directory = scratchDirectories.pop();

    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("WorktreeService repository bootstrap", () => {
  function makeService(baseBranch = "main") {
    const { base, repoRoot } = tempWorkspace();
    scratchDirectories.push(base);

    const service = new WorktreeService({
      repoRoot,
      worktreesRoot: path.join(base, "worktrees"),
      baseBranch,
      authorName: "TaskFleet Bot",
      authorEmail: "bot@taskfleet.test",
    });

    return { service, repoRoot };
  }

  it("initializes a non-Git workspace with identity, base branch, and initial commit", async () => {
    const { service, repoRoot } = makeService();

    expect(await service.isGitRepository()).toBe(false);

    const result = await service.ensureRepository();

    expect(result).toMatchObject({
      repoRoot,
      baseBranch: "main",
      initialized: true,
      initialCommitCreated: true,
    });
    expect(await service.isGitRepository()).toBe(true);
    expect(git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(git(repoRoot, ["config", "user.name"])).toBe("TaskFleet Bot");
    expect(git(repoRoot, ["config", "user.email"])).toBe(
      "bot@taskfleet.test"
    );
    expect(git(repoRoot, ["log", "-1", "--format=%an <%ae>"])).toBe(
      "TaskFleet Bot <bot@taskfleet.test>"
    );
  });

  it("is idempotent and never re-initializes an existing commit history", async () => {
    const { service, repoRoot } = makeService();

    await service.ensureRepository();
    const head = git(repoRoot, ["rev-parse", "HEAD"]);

    const second = await service.ensureRepository();

    expect(second).toMatchObject({
      initialized: false,
      initialCommitCreated: false,
    });
    expect(git(repoRoot, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("preserves an existing repository and its identity", async () => {
    const { base, repoRoot } = tempWorkspace();
    scratchDirectories.push(base);

    execFileSync("git", ["init", "-q", "-b", "trunk", repoRoot]);
    git(repoRoot, ["config", "user.email", "owner@example.com"]);
    git(repoRoot, ["config", "user.name", "Repository Owner"]);
    writeFileSync(path.join(repoRoot, "README.md"), "# existing\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-qm", "existing history"]);
    const head = git(repoRoot, ["rev-parse", "HEAD"]);

    const service = new WorktreeService({
      repoRoot,
      worktreesRoot: path.join(base, "worktrees"),
      baseBranch: "main",
      authorName: "TaskFleet Bot",
      authorEmail: "bot@taskfleet.test",
    });

    const result = await service.ensureRepository();

    expect(result.initialized).toBe(false);
    expect(result.initialCommitCreated).toBe(false);
    expect(git(repoRoot, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("trunk");
    expect(git(repoRoot, ["config", "user.name"])).toBe("Repository Owner");
    expect(git(repoRoot, ["config", "user.email"])).toBe(
      "owner@example.com"
    );
  });

  it("serializes concurrent initialization", async () => {
    const { service, repoRoot } = makeService();

    const [first, second] = await Promise.all([
      service.ensureRepository(),
      service.ensureRepository(),
    ]);

    expect(first.initialized).toBe(true);
    expect(second.initialized).toBe(true);
    expect(git(repoRoot, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("creates a worktree from a freshly initialized workspace", async () => {
    const { service } = makeService();

    const worktree = await service.ensureForRun("task-new", "run-new");

    expect(existsSync(worktree.path)).toBe(true);
    expect(worktree.branch).toBe("taskfleet/run-new");
    expect(await service.isGitRepository()).toBe(true);
  });

  it("configures an HTTPS origin without embedding credentials", async () => {
    const { service, repoRoot } = makeService();
    await service.ensureRepository();

    const remote = "https://github.com/acme/demo.git";
    await service.configureRemote(remote);

    expect(await service.getRemote("origin")).toBe(remote);
    expect(git(repoRoot, ["remote", "get-url", "origin"])).toBe(remote);
    expect(git(repoRoot, ["config", "--get", "remote.origin.url"])).toBe(
      remote
    );

    await service.configureRemote("https://github.com/acme/renamed.git");
    expect(await service.getRemote("origin")).toBe(
      "https://github.com/acme/renamed.git"
    );
  });

  it("rejects unsafe remotes and remote names", async () => {
    const { service } = makeService();
    await service.ensureRepository();

    await expect(
      service.configureRemote("http://github.com/acme/demo.git")
    ).rejects.toThrow("must use HTTPS");
    await expect(
      service.configureRemote("https://github.com/acme/demo.git", "../evil")
    ).rejects.toThrow("Unsafe remote name");
    expect(await service.getRemote("missing")).toBeNull();
  });
});

describe("RepositoryService", () => {
  function makeRepositoryService(options: {
    baseBranch?: string;
    githubToken?: string;
    githubRepository?: string;
    githubClient?: RepositoryCreator;
    onGithubConfigured?: (integration: GitHubIntegration) => void;
  } = {}) {
    const worktrees = {
      repoRoot: "/workspace/repo",
      baseBranch: options.baseBranch ?? "main",
      isGitRepository: vi.fn(async () => true),
      getRemote: vi.fn(async () => null),
      ensureRepository: vi.fn(async () => ({
        repoRoot: "/workspace/repo",
        baseBranch: options.baseBranch ?? "main",
        initialized: false,
        initialCommitCreated: false,
      })),
      configureRemote: vi.fn(async () => undefined),
      pushHead: vi.fn(async () => undefined),
    };

    const service = new RepositoryService({
      worktrees: worktrees as unknown as WorktreeService,
      baseBranch: options.baseBranch ?? "main",
      ...(options.githubToken ? { githubToken: options.githubToken } : {}),
      ...(options.githubRepository
        ? { githubRepository: options.githubRepository }
        : {}),
      ...(options.githubClient ? { githubClient: options.githubClient } : {}),
      ...(options.onGithubConfigured
        ? { onGithubConfigured: options.onGithubConfigured }
        : {}),
    });

    return { service, worktrees };
  }

  it("bootstraps the local repository without touching GitHub", async () => {
    const { service, worktrees } = makeRepositoryService();

    const result = await service.bootstrap();

    expect(worktrees.ensureRepository).toHaveBeenCalledTimes(1);
    expect(result.github).toBeNull();
    expect(result.initialPush).toBeNull();
  });

  it("reports repository status", async () => {
    const { service, worktrees } = makeRepositoryService({
      githubRepository: "acme/existing",
    });

    const status = await service.status();

    expect(status).toEqual({
      repoRoot: "/workspace/repo",
      baseBranch: "main",
      isGitRepository: true,
      originUrl: null,
      githubRepository: "acme/existing",
    });
    expect(worktrees.isGitRepository).toHaveBeenCalled();
  });

  it("requires a token before creating a GitHub repository", async () => {
    const { service } = makeRepositoryService();

    await expect(
      service.bootstrap({ createGithub: true, name: "demo" })
    ).rejects.toMatchObject({
      code: "GITHUB_TOKEN_MISSING",
      statusCode: 503,
    });
  });

  it("validates the repository name", async () => {
    const createRepository = vi.fn();
    const { service } = makeRepositoryService({
      githubToken: "token",
      githubClient: { createRepository } as RepositoryCreator,
    });

    await expect(
      service.bootstrap({ createGithub: true, name: "../escape" })
    ).rejects.toBeInstanceOf(RepositoryBootstrapError);
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("creates the GitHub repository, configures origin, and pushes the base branch", async () => {
    const createRepository = vi.fn(async () => createdRepository());
    const captured: { value: GitHubIntegration | null } = { value: null };
    const { service, worktrees } = makeRepositoryService({
      githubToken: "secret-token",
      githubClient: { createRepository } as RepositoryCreator,
      onGithubConfigured: (value) => {
        captured.value = value;
      },
    });

    const result = await service.bootstrap({
      createGithub: true,
      name: "demo",
      description: "Demo project",
      private: true,
      owner: "acme",
      organization: true,
    });

    expect(createRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        description: "Demo project",
        private: true,
        owner: "acme",
        organization: true,
      })
    );
    expect(worktrees.configureRemote).toHaveBeenCalledWith(
      "https://github.com/acme/demo.git",
      "origin"
    );
    expect(worktrees.pushHead).toHaveBeenCalledWith("main", {
      remoteUrl: "https://github.com/acme/demo.git",
      token: "secret-token",
    });
    expect(result).toMatchObject({
      originUrl: "https://github.com/acme/demo.git",
      github: { fullName: "acme/demo" },
      initialPush: { pushed: true, branch: "main" },
    });
    expect(captured.value).not.toBeNull();
    expect(captured.value?.repository).toBe("acme/demo");
    expect(captured.value?.baseBranch).toBe("main");
    expect(captured.value?.remoteUrl).toBe("https://github.com/acme/demo.git");
    expect(captured.value?.client).toBeDefined();
  });

  it("reports an initial push failure without discarding the repository", async () => {
    const { service, worktrees } = makeRepositoryService({
      githubToken: "secret-token",
      githubClient: { createRepository: async () => createdRepository() },
    });
    worktrees.pushHead.mockRejectedValueOnce(
      new Error("remote rejected secret-token")
    );

    const result = await service.bootstrap({
      createGithub: true,
      name: "demo",
    });

    expect(result.github?.fullName).toBe("acme/demo");
    expect(result.initialPush).toMatchObject({
      pushed: false,
      branch: "main",
    });
    expect(result.initialPush?.error).not.toContain("secret-token");
    expect(result.initialPush?.error).toContain("[redacted]");
  });

  it("redacts the token from GitHub creation errors", async () => {
    const { service } = makeRepositoryService({
      githubToken: "secret-token",
      githubClient: {
        createRepository: async () => {
          throw new GitHubError("unauthorized secret-token", 401);
        },
      },
    });

    await expect(
      service.bootstrap({ createGithub: true, name: "demo" })
    ).rejects.toThrow("unauthorized [redacted]");
  });
});

describe("repository routes", () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createTestDatabase();
    app = buildApp({
      logger: false,
      config: testConfig(db.config.databaseUrl),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.cleanup();
  });

  it("reports repository status", async () => {
    const response = await app.inject({ method: "GET", url: "/repository" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      repository: {
        baseBranch: "main",
        isGitRepository: true,
        githubRepository: null,
      },
    });
  });

  it("validates the bootstrap request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/repository",
      payload: { createGithub: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "name" }),
      ]),
    });
  });
});
