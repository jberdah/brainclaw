import { z } from 'zod';

export const WorkIntentSchema = z.enum(['execute', 'consult', 'resume', 'review']);
export const CoordinateIntentSchema = z.enum(['assign', 'consult', 'review', 'reroute', 'summarize']);

export const WorkRequestSchema = z.object({
  intent: WorkIntentSchema,
  scope: z.string().optional(),
  planId: z.string().optional(),
  task: z.string().optional(),
  messageId: z.string().optional(),
  contextTarget: z.string().optional(),
});

export const CoordinateRequestSchema = z.object({
  intent: CoordinateIntentSchema,
  task: z.string(),
  scope: z.string().optional(),
  targetAgents: z.array(z.string()).optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  threadId: z.string().optional(),
});

export const FacadeArtifactSchema = z.object({
  type: z.string(),
  id: z.string(),
  path: z.string().optional(),
});

export const FacadeSideEffectSchema = z.object({
  action: z.string(),
  entity: z.string(),
  id: z.string(),
});

export const FacadeResponseSchema = z.object({
  status: z.enum(['ok', 'error', 'partial']),
  intent: z.string(),
  result: z.unknown(),
  artifacts: z.array(FacadeArtifactSchema),
  side_effects: z.array(FacadeSideEffectSchema),
  error: z.string().optional(),
  duration_ms: z.number().optional(),
  claim_status: z.enum(['created', 'existing', 'none']).optional(),
  session_id: z.string().optional(),
  warnings: z.array(z.string()),
});

export type WorkIntent = z.infer<typeof WorkIntentSchema>;
export type CoordinateIntent = z.infer<typeof CoordinateIntentSchema>;
export type WorkRequest = z.infer<typeof WorkRequestSchema>;
export type CoordinateRequest = z.infer<typeof CoordinateRequestSchema>;
export type FacadeArtifact = z.infer<typeof FacadeArtifactSchema>;
export type FacadeSideEffect = z.infer<typeof FacadeSideEffectSchema>;
export type FacadeResponse = z.infer<typeof FacadeResponseSchema>;
