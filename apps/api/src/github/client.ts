import { z } from "zod";

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.string(),
  title: z.string(),
});

const repositorySchema = z.object({
  name: z.string(),
  full_name: z.string(),
  html_url: z.string().url(),
  clone_url: z.string().url(),
  ssh_url: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  owner: z.object({ login: z.string() }),
});

export interface GitHubClientOptions {
  token: string;
  /** Required for pull requests, optional while creating a repository. */
  repository?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface CreateRepositoryInput {
  name: string;
  description?: string;
  private?: boolean;
  /** Organization login. Omit to create under the authenticated user. */
  owner?: string;
  /** When true, `owner` is treated as an organization. */
  organization?: boolean;
  /** Let GitHub create an initial commit/branch. */
  autoInit?: boolean;
}

export interface CreatedRepository {
  name: string;
  fullName: string;
  url: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  private: boolean;
  owner: string;
}

export interface CreatePullRequestInput {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export interface PullRequest {
  number: number;
  url: string;
  state: string;
  title: string;
}

export class GitHubError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/**
 * Thin client for the GitHub REST API. Supports creating a repository and
 * opening a pull request with the same token used by the rest of TaskFleet.
 */
export class GitHubClient {
  readonly #token: string;
  readonly #repository: string | null;
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#repository = options.repository ?? null;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      ""
    );
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Creates a repository under the authenticated user, or under an
   * organization when `owner` + `organization` are supplied.
   */
  async createRepository(
    input: CreateRepositoryInput
  ): Promise<CreatedRepository> {
    const endpoint =
      input.organization && input.owner
        ? `${this.#baseUrl}/orgs/${encodeURIComponent(input.owner)}/repos`
        : `${this.#baseUrl}/user/repos`;

    const response = await this.#fetchImpl(endpoint, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({
        name: input.name,
        private: input.private ?? true,
        auto_init: input.autoInit ?? false,
        ...(input.description ? { description: input.description } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");

      throw new GitHubError(
        `GitHub repository creation failed (${response.status}): ${detail.slice(0, 300)}`,
        response.status
      );
    }

    const parsed = repositorySchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new GitHubError("Unexpected GitHub repository response.");
    }

    return {
      name: parsed.data.name,
      fullName: parsed.data.full_name,
      url: parsed.data.html_url,
      cloneUrl: parsed.data.clone_url,
      sshUrl: parsed.data.ssh_url,
      defaultBranch: parsed.data.default_branch,
      private: parsed.data.private,
      owner: parsed.data.owner.login,
    };
  }

  async createPullRequest(
    input: CreatePullRequestInput
  ): Promise<PullRequest> {
    const repository = this.#repository;

    if (!repository) {
      throw new GitHubError(
        "GitHub repository is not configured; cannot open a pull request."
      );
    }

    const response = await this.#fetchImpl(
      `${this.#baseUrl}/repos/${repository}/pulls`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({
          title: input.title,
          head: input.head,
          base: input.base,
          ...(input.body ? { body: input.body } : {}),
          ...(input.draft !== undefined ? { draft: input.draft } : {}),
        }),
      }
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");

      throw new GitHubError(
        `GitHub PR creation failed (${response.status}): ${detail.slice(0, 300)}`,
        response.status
      );
    }

    const parsed = pullRequestSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new GitHubError("Unexpected GitHub pull request response.");
    }

    return {
      number: parsed.data.number,
      url: parsed.data.html_url,
      state: parsed.data.state,
      title: parsed.data.title,
    };
  }

  #headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.#token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    };
  }
}
