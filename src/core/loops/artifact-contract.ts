import { z } from 'zod';

/** Immutable description of one artifact expected from a worker attempt. */
export const ExpectedArtifactSchema = z.object({
  logical_name: z.string().min(1),
  worker_path: z.string().min(1),
  loop_artifact_type: z.string().min(1),
  schema_id: z.string().optional(),
  completion_policy: z.enum(['required', 'optional']).default('required'),
  sha256: z.string().optional(),
});

export type ExpectedArtifact = z.infer<typeof ExpectedArtifactSchema>;
