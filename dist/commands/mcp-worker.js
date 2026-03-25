import { parentPort, workerData } from 'node:worker_threads';
import { executeMcpToolCall } from './mcp.js';
async function main() {
    const delayMs = Number.parseInt(process.env.BRAINCLAW_MCP_TEST_DELAY_MS ?? '0', 10);
    if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const result = await executeMcpToolCall(workerData);
    parentPort?.postMessage(result);
}
void main();
//# sourceMappingURL=mcp-worker.js.map