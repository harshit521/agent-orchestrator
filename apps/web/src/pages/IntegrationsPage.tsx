import { useState } from "react";

import { API_BASE, api, githubWebhookUrl } from "../api";
import { useQuery } from "../hooks/useQuery";
import { messageOf } from "../lib/errors";
import { formatDuration } from "../lib/format";
import { hrefFor } from "../lib/router";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { CopyButton } from "../components/ui/CopyButton";
import { Checkbox, FormField, Input } from "../components/ui/Field";
import { Icon } from "../components/ui/Icon";
import { PageHeader } from "../components/ui/PageHeader";
import {
  MetadataGrid,
  Panel,
  PanelBody,
  PanelHeader,
} from "../components/ui/Panel";
import {
  EmptyState,
  ErrorState,
  InlineError,
  Skeleton,
} from "../components/ui/States";
import { useToast } from "../components/ui/Toast";

function BoolBadge({
  value,
  trueLabel = "configured",
  falseLabel = "missing",
  invert = false,
}: {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
  invert?: boolean;
}) {
  const positive = invert ? !value : value;

  return (
    <Badge tone={positive ? "success" : "warning"} dot>
      {value ? trueLabel : falseLabel}
    </Badge>
  );
}

function RepositoryPanel({
  githubTokenConfigured,
  onConfigured,
}: {
  githubTokenConfigured: boolean;
  onConfigured: () => void;
}) {
  const repository = useQuery("repository", api.repository.status, {
    refreshInterval: 30_000,
  });
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [makePrivate, setMakePrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = repository.data?.repository ?? null;

  const bootstrap = async (createGithub: boolean) => {
    setBusy(true);
    setError(null);

    try {
      const result = await api.repository.bootstrap(
        createGithub
          ? { createGithub: true, name: name.trim(), private: makePrivate }
          : {}
      );

      const pushed = result.initialPush?.pushed;

      toast({
        title: createGithub
          ? "GitHub repository created"
          : "Workspace initialized",
        description: createGithub
          ? `${result.github?.fullName ?? "Repository"} configured as origin${
              pushed ? ` and ${result.initialPush?.branch} was pushed.` : "."
            }`
          : "The local Git repository is ready for worktrees.",
        variant: "success",
      });

      if (createGithub) {
        setName("");
      }

      repository.refetch();
      onConfigured();
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHeader
        title="Repository"
        description="Git workspace and GitHub origin used by coding runs"
        action={
          <Badge
            tone={data?.isGitRepository ? "success" : "warning"}
            dot
          >
            {data?.isGitRepository ? "initialized" : "not initialized"}
          </Badge>
        }
      />
      <PanelBody>
        {repository.error && !data ? (
          <InlineError
            message={repository.error}
            onRetry={repository.refetch}
          />
        ) : repository.loading && !data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <MetadataGrid
              items={[
                {
                  label: "Workspace",
                  value: data?.repoRoot ?? "unknown",
                  mono: true,
                },
                {
                  label: "Base branch",
                  value: data?.baseBranch ?? "main",
                  mono: true,
                },
                {
                  label: "Origin",
                  value: data?.originUrl ?? "not configured",
                  mono: true,
                },
                {
                  label: "GitHub",
                  value: data?.githubRepository ?? "not connected",
                  mono: true,
                },
              ]}
            />

            {error ? (
              <p className="mt-3 rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-[11px] leading-5 text-danger">
                {error}
              </p>
            ) : null}

            {!data?.isGitRepository ? (
              <div className="mt-4 border-t border-line pt-4">
                <p className="text-[11px] leading-5 text-muted">
                  The workspace is not a Git repository yet. Initialize it with
                  TaskFleet's author identity and an initial commit before
                  starting a coding run.
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() => void bootstrap(false)}
                >
                  Initialize workspace
                </Button>
              </div>
            ) : null}

            <div className="mt-4 border-t border-line pt-4">
              <p className="text-[10px] font-medium tracking-[0.08em] text-muted uppercase">
                Create a GitHub repository
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <FormField
                  label="Repository name"
                  htmlFor="repository-name"
                  hint={
                    githubTokenConfigured
                      ? "Created under the token owner and configured as origin."
                      : "Set GITHUB_TOKEN to create a repository."
                  }
                >
                  <Input
                    id="repository-name"
                    value={name}
                    placeholder="my-new-project"
                    onChange={(event) => setName(event.target.value)}
                    disabled={!githubTokenConfigured || busy}
                  />
                </FormField>
                <Button
                  size="sm"
                  loading={busy}
                  disabled={!githubTokenConfigured || name.trim().length === 0}
                  onClick={() => void bootstrap(true)}
                >
                  Create repository
                </Button>
              </div>
              <Checkbox
                className="mt-3"
                label="Private repository"
                description="Disable to create a public repository."
                checked={makePrivate}
                disabled={!githubTokenConfigured || busy}
                onChange={(event) => setMakePrivate(event.target.checked)}
              />
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

export function IntegrationsPage() {
  const integrations = useQuery("integrations", api.integrations, {
    refreshInterval: 30_000,
  });
  const worktrees = useQuery("worktrees", api.worktrees.list, {
    refreshInterval: 30_000,
  });

  if (integrations.loading && !integrations.data) {
    return (
      <div className="space-y-5">
        <PageHeader title="Integrations" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (integrations.error && !integrations.data) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Integrations"
          description="Runtime configuration reported by the backend."
        />
        <ErrorState
          message={integrations.error}
          onRetry={integrations.refetch}
        />
      </div>
    );
  }

  const data = integrations.data;

  if (!data) {
    return null;
  }

  const llm = data.llm;
  const isStub = llm.provider === "stub";
  const webhookUrl = githubWebhookUrl();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Integrations"
        description="Live configuration reported by the backend. Secrets are never exposed."
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              integrations.refetch();
              worktrees.refetch();
            }}
            loading={integrations.refreshing}
            leading={<Icon name="refresh" className="h-3.5 w-3.5" />}
          >
            Refresh
          </Button>
        }
      />

      {integrations.error ? (
        <InlineError
          message={`${integrations.error} Showing the last loaded configuration.`}
          onRetry={integrations.refetch}
        />
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Language model"
            description="Provider used by the agent runtime"
            action={
              isStub ? (
                <Badge tone="warning" dot>
                  Stub · offline
                </Badge>
              ) : (
                <BoolBadge
                  value={llm.configured}
                  trueLabel="configured"
                  falseLabel="API key missing"
                />
              )
            }
          />
          <PanelBody>
            <MetadataGrid
              items={[
                {
                  label: "Provider",
                  value: <span className="font-mono text-xs">{llm.provider}</span>,
                },
                {
                  label: "Model",
                  value: (
                    <span className="font-mono text-xs">
                      {llm.model ?? "provider default"}
                    </span>
                  ),
                },
                {
                  label: "Credentials",
                  value: llm.configured ? "present" : "missing",
                },
              ]}
            />
            <p className="mt-3 text-[11px] leading-5 text-muted">
              {isStub
                ? "The backend is running the deterministic offline stub. Executions succeed or fail deterministically without calling a live model, and token usage is not reported."
                : llm.configured
                  ? `Executions call the real ${llm.provider} API. Token usage is displayed on run pages when the provider returns it.`
                  : `LLM_PROVIDER is set to ${llm.provider}, but no API key is configured. Set LLM_API_KEY before starting a run.`}
            </p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="GitHub"
            description="Webhook-driven task status updates"
            action={
              <BoolBadge
                value={data.github.tokenConfigured}
                trueLabel="token present"
                falseLabel="no token"
              />
            }
          />
          <PanelBody>
            <MetadataGrid
              items={[
                {
                  label: "Repository",
                  value: (
                    <span className="font-mono text-xs">
                      {data.github.repository ?? "not set"}
                    </span>
                  ),
                },
                {
                  label: "Token",
                  value: data.github.tokenConfigured ? "configured" : "missing",
                },
                {
                  label: "Webhook secret",
                  value: data.github.webhookConfigured
                    ? "configured"
                    : "missing",
                },
              ]}
            />

            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[10px] font-medium tracking-[0.08em] text-muted uppercase">
                Webhook endpoint
              </p>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded border border-line bg-subtle px-2 py-1 font-mono text-[11px] text-fg">
                  {webhookUrl}
                </code>
                <CopyButton value={webhookUrl} label="Copy webhook URL" />
              </div>
              <p className="mt-2 text-[11px] leading-5 text-muted">
                Configure a GitHub webhook for{" "}
                <code className="font-mono">pull_request</code>,{" "}
                <code className="font-mono">check_suite</code>,{" "}
                <code className="font-mono">check_run</code> and{" "}
                <code className="font-mono">push</code>. Requests are verified
                with <code className="font-mono">X-Hub-Signature-256</code>.
                Branch names of the form{" "}
                <code className="font-mono">taskfleet/&lt;taskId&gt;</code> are
                mapped back to tasks.
              </p>
              {!data.github.webhookConfigured ? (
                <p className="mt-2 rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-[11px] leading-5 text-warn">
                  Set <code className="font-mono">GITHUB_WEBHOOK_SECRET</code> to
                  enable the endpoint. Without it, the backend returns 503.
                </p>
              ) : null}
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Worktrees"
            description="Isolated git worktrees per task"
            action={
              <Badge tone={data.worktrees.enabled ? "success" : "neutral"} dot>
                {data.worktrees.enabled ? "enabled" : "disabled"}
              </Badge>
            }
          />
          {!data.worktrees.enabled ? (
            <PanelBody>
              <p className="text-[11px] leading-5 text-muted">
                Worktree isolation is disabled. Set{" "}
                <code className="font-mono">WORKTREES_ENABLED=true</code> to let
                the backend create and track task worktrees.
              </p>
            </PanelBody>
          ) : worktrees.error ? (
            <PanelBody>
              <InlineError
                message={worktrees.error}
                onRetry={worktrees.refetch}
              />
            </PanelBody>
          ) : worktrees.loading && !worktrees.data ? (
            <PanelBody>
              <Skeleton className="h-16 w-full" />
            </PanelBody>
          ) : worktrees.data && !worktrees.data.isGitRepository ? (
            <PanelBody>
              <p className="text-[11px] text-muted">
                Worktrees are enabled, but the project root is not a git
                repository.
              </p>
            </PanelBody>
          ) : (worktrees.data?.worktrees.length ?? 0) === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title="No active worktrees"
                description="Task worktrees appear here after the backend creates them."
              />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {worktrees.data?.worktrees.map((worktree) => (
                <li key={worktree.path} className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <a
                      href={hrefFor(`/tasks/${worktree.taskId}`)}
                      className="font-mono text-[11px] text-fg hover:text-accent"
                    >
                      {worktree.taskId}
                    </a>
                    <span className="truncate font-mono text-[10px] text-muted">
                      {worktree.branch}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
                    {worktree.path}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Security scanning"
            description="Scanner gate for the repository"
            action={
              <Badge tone={data.security.enabled ? "success" : "neutral"} dot>
                {data.security.enabled ? "enabled" : "disabled"}
              </Badge>
            }
          />
          <PanelBody>
            <p className="text-[11px] leading-5 text-muted">
              {data.security.enabled
                ? "The security scan endpoint is enabled. Scanner availability is probed on the Security page."
                : "Security scanning is disabled. Set SECURITY_ENABLED=true to expose the scan endpoint."}
            </p>
            <a
              href={hrefFor("/security")}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
            >
              Open security
              <Icon name="arrowUpRight" className="h-3 w-3" />
            </a>
          </PanelBody>
        </Panel>
      </div>

      <RepositoryPanel
        githubTokenConfigured={data.github.tokenConfigured}
        onConfigured={() => {
          integrations.refetch();
          worktrees.refetch();
        }}
      />

      <Panel>
        <PanelHeader
          title="API connection"
          description="How this frontend reaches the backend"
          action={<BoolBadge value={data.health.status === "ok"} trueLabel="healthy" falseLabel="degraded" />}
        />
        <PanelBody>
          <MetadataGrid
            items={[
              { label: "Base URL", value: API_BASE, mono: true },
              {
                label: "Health",
                value: data.health.status,
              },
              {
                label: "Uptime",
                value: formatDuration(data.health.uptimeSeconds * 1000),
              },
              {
                label: "Frontend env",
                value: "VITE_API_URL",
                mono: true,
              },
            ]}
          />
          <p className="mt-3 text-[11px] leading-5 text-muted">
            Requests use the centralized typed client. In development the Vite
            proxy forwards <code className="font-mono">/api</code> to the
            backend; set <code className="font-mono">VITE_API_URL</code> to
            target a different origin.
          </p>
        </PanelBody>
      </Panel>
    </div>
  );
}
