import { parentPort, workerData } from 'node:worker_threads';
import { executeMcpToolCall, type McpToolExecutionOutcome, type McpToolExecutionPayload } from './mcp.js';

async function main(): Promise<void> {
  const delayMs = Number.parseInt(process.env.BRAINCLAW_MCP_TEST_DELAY_MS ?? '0', 10);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const result = await executeMcpToolCall(workerData as McpToolExecutionPayload);
  parentPort?.postMessage(result satisfies McpToolExecutionOutcome);
}

void main();
