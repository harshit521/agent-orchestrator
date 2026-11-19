import {
  GitHubClient,
  GitHubError,
  type CreateRepositoryInput,
  type CreatedRepository,
} from "../github/client.js";
import type { GitHubIntegration } from "../github/integration.js";
import {
  redactSecrets,
  type RepositoryBootstrapResult,
  type WorktreeService,
} from "../worktrees/worktree-service.js";

const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The subset of `GitHubClient` needed to create a repository. */
export interface RepositoryCreator {
  createRepository(input: CreateRepositoryInput): Promise<CreatedRepository>;
}

export interface RepositoryServiceOptions {
  worktrees: WorktreeService;
  baseBranch: string;
  githubToken?: string;
  /** Repository configured through `GITHUB_REPOSITORY`, if any. */
  githubRepository?: string;
  /** Injectable for tests; defaults to a real GitHub client when a token exists. */
  githubClient?: RepositoryCreator;
  /** Called after a new GitHub repository becomes the active integration. */
  onGithubConfigured?: (integration: GitHubIntegration) => void;
}

export interface RepositoryStatus {
  repoRoot: string;
  baseBranch: string;
  isGitRepository: boolean;
  originUrl: string | null;
  githubRepository: string | null;
}

export interface BootstrapRepositoryInput {
  createGithub?: boolean;
  name?: string | undefined;
  description?: string | undefined;
  private?: boolean;
  owner?: string | undefined;
  organization?: boolean;
  initialCommitMessage?: string | undefined;
  pushInitialBranch?: boolean;
}

export interface InitialPushResult {
  pushed: boolean;
  branch: string;
  error?: string;
}

export interface RepositoryBootstrapResponse {
  local: RepositoryBootstrapResult;
  originUrl: string | null;
  github: CreatedRepository | null;
  initialPush: InitialPushResult | null;
}

export class RepositoryBootstrapError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = "REPOSITORY_ERROR") {
    super(message);
    this.name = "RepositoryBootstrapError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Owns repository-level setup: local Git initialization, optional GitHub
 * repository creation, origin configuration, and the first base-branch push.
 *
 * Worktree creation itself stays in `WorktreeService`; this service only
 * prepares the repository those worktrees branch from.
 */
export class RepositoryService {
  readonly #worktrees: WorktreeService;
  readonly #baseBranch: string;
  readonly #githubToken: string | undefined;
  readonly #githubClient: RepositoryCreator | null;
  readonly #onGithubConfigured:
    | ((integration: GitHubIntegration) => void)
    | undefined;
  #githubRepository: string | null;

  constructor(options: RepositoryServiceOptions) {
    this.#worktrees = options.worktrees;
    this.#baseBranch = options.baseBranch;
    this.#githubToken = options.githubToken;
    this.#githubClient =
      options.githubClient ??
      (options.githubToken
        ? new GitHubClient({ token: options.githubToken })
        : null);
    this.#onGithubConfigured = options.onGithubConfigured;
    this.#githubRepository = options.githubRepository ?? null;
  }

  async status(): Promise<RepositoryStatus> {
    const isGitRepository = await this.#worktrees.isGitRepository();

    return {
      repoRoot: this.#worktrees.repoRoot,
      baseBranch: this.#baseBranch,
      isGitRepository,
      originUrl: isGitRepository
        ? await this.#worktrees.getRemote("origin")
        : null,
      githubRepository: this.#githubRepository,
    };
  }

  /**
   * Bootstraps the current workspace. When `createGithub` is true, a new
   * repository is created through the configured token, `origin` is pointed
   * at it, and the local base branch is pushed so PRs have a base.
   */
  async bootstrap(
    input: BootstrapRepositoryInput = {}
  ): Promise<RepositoryBootstrapResponse> {
    const local = await this.#worktrees.ensureRepository({
      ...(input.initialCommitMessage
        ? { initialCommitMessage: input.initialCommitMessage }
        : {}),
    });

    if (!input.createGithub) {
      return {
        local,
        originUrl: await this.#worktrees.getRemote("origin"),
        github: null,
        initialPush: null,
      };
    }

    const name = input.name?.trim();

    if (!name || !REPOSITORY_NAME.test(name)) {
      throw new RepositoryBootstrapError(
        "A valid GitHub repository name is required.",
        400,
        "INVALID_REPOSITORY_NAME"
      );
    }

    if (!this.#githubToken || !this.#githubClient) {
      throw new RepositoryBootstrapError(
        "GITHUB_TOKEN is required to create a GitHub repository.",
        503,
        "GITHUB_TOKEN_MISSING"
      );
    }

    let github: CreatedRepository;

    try {
      github = await this.#githubClient.createRepository({
        name,
        private: input.private ?? true,
        autoInit: false,
        ...(input.description ? { description: input.description } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.organization ? { organization: true } : {}),
      });
    } catch (error: unknown) {
      if (error instanceof GitHubError) {
        throw new RepositoryBootstrapError(
          redactSecrets(error.message, [this.#githubToken]),
          error.status === 401 || error.status === 403 ? 502 : 400,
          "GITHUB_REPOSITORY_CREATE_FAILED"
        );
      }

      throw error;
    }

    await this.#worktrees.configureRemote(github.cloneUrl, "origin");

    let initialPush: InitialPushResult | null = null;

    if (input.pushInitialBranch !== false) {
      try {
        await this.#worktrees.pushHead(this.#baseBranch, {
          remoteUrl: github.cloneUrl,
          token: this.#githubToken,
        });

        initialPush = { pushed: true, branch: this.#baseBranch };
      } catch (error: unknown) {
        initialPush = {
          pushed: false,
          branch: this.#baseBranch,
          error: redactSecrets(
            error instanceof Error ? error.message : String(error),
            [this.#githubToken]
          ),
        };
      }
    }

    this.#githubRepository = github.fullName;

    const integration: GitHubIntegration = {
      client: new GitHubClient({
        token: this.#githubToken,
        repository: github.fullName,
      }),
      repository: github.fullName,
      baseBranch: this.#baseBranch,
      remoteUrl: github.cloneUrl,
    };

    this.#onGithubConfigured?.(integration);

    return {
      local,
      originUrl: github.cloneUrl,
      github,
      initialPush,
    };
  }
}
