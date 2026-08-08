import crypto from 'node:crypto';
import { z } from 'zod';
import { generateId, nowISO } from './ids.js';

export const FederationMessageSchema = z.object({
  schema_version: z.literal(1),
  id: z.string(),
  version: z.number().int().min(1),
  idempotency_key: z.string(),
  from: z.object({
    project_id: z.string().optional(),
    project_name: z.string(),
    project_path: z.string(),
    agent_name: z.string(),
    agent_id: z.string().optional(),
    host_id: z.string().optional(),
  }).strict(),
  to: z.object({
    project_name: z.string(),
    project_path: z.string(),
    agent_name: z.string().optional(),
  }).strict(),
  type: z.enum(['handoff', 'candidate', 'runtime_note']),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  causal_parent: z.string().optional(),
}).strict();

export type FederationMessage = z.infer<typeof FederationMessageSchema>;

function computeIdempotencyKey(
  msg: Pick<FederationMessage, 'from' | 'to' | 'type' | 'payload'>,
): string {
  const data = JSON.stringify({ from: msg.from, to: msg.to, type: msg.type, payload: msg.payload });
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

export function createFederationMessage(
  input: Omit<FederationMessage, 'id' | 'schema_version' | 'created_at' | 'idempotency_key'>,
): FederationMessage {
  return {
    ...input,
    schema_version: 1,
    id: generateId('msg'),
    created_at: nowISO(),
    idempotency_key: computeIdempotencyKey(input),
  };
}

export function validateMessage(raw: unknown): FederationMessage {
  return FederationMessageSchema.parse(raw);
}

export function serializeMessage(msg: FederationMessage): string {
  return JSON.stringify(msg, null, 2);
}

export function deserializeMessage(raw: string): FederationMessage {
  return validateMessage(JSON.parse(raw));
}

export function isDuplicate(existing: FederationMessage[], incoming: FederationMessage): boolean {
  return existing.some((m) => m.idempotency_key === incoming.idempotency_key);
}
