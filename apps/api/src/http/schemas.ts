import { z } from "zod";

import { DEFAULT_AGENT_ID } from "../agents/index.js";

const promptSchema = z
  .string()
  .trim()
  .min(1, "A non-empty prompt is required.")
  .max(8000, "Prompt is too long.");

const agentIdSchema = z
  .string()
  .trim()
  .min(1)
  .default(DEFAULT_AGENT_ID);

export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "in_review",
  "completed",
  "failed",
  "ready_to_merge",
]);

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const createTaskSchema = z.object({
  prompt: promptSchema,
  title: z.string().trim().min(1).max(200).optional(),
  agentId: agentIdSchema,
  priority: taskPrioritySchema.default("medium"),
  start: z.boolean().default(true),
});

export type CreateTaskBody = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    prompt: promptSchema.optional(),
    agentId: z.string().trim().min(1).optional(),
    priority: taskPrioritySchema.optional(),
    status: taskStatusSchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    { message: "At least one field must be provided." }
  );

export type UpdateTaskBody = z.infer<typeof updateTaskSchema>;

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: runStatusSchema.optional(),
  agentId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
});

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const researchRequestSchema = z.object({
  input: promptSchema,
  agentId: agentIdSchema,
});

export type ResearchRequestBody = z.infer<typeof researchRequestSchema>;

const repositoryNameSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
    "Use letters, digits, dots, dashes, or underscores."
  );

export const repositoryBootstrapSchema = z
  .object({
    createGithub: z.boolean().default(false),
    name: repositoryNameSchema.optional(),
    description: z.string().trim().max(350).optional(),
    private: z.boolean().default(true),
    owner: z.string().trim().min(1).max(100).optional(),
    organization: z.boolean().default(false),
    initialCommitMessage: z.string().trim().min(1).max(200).optional(),
    pushInitialBranch: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.createGithub && !value.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "A repository name is required when creating GitHub.",
      });
    }

    if (value.organization && !value.owner) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["owner"],
        message: "An organization owner is required.",
      });
    }
  });

export type RepositoryBootstrapBody = z.infer<typeof repositoryBootstrapSchema>;
