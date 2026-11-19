import type { GitHubClient } from "./client.js";

/**
 * Runtime GitHub configuration shared by the run lifecycle and repository
 * bootstrap service. The client is replaced when a new repository is created
 * so the next run can push and open pull requests without a restart.
 */
export interface GitHubIntegration {
  client: GitHubClient;
  repository: string;
  baseBranch: string;
  remoteUrl?: string;
}
