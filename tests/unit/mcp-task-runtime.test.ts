import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpTaskRunner, type JsonRpcId, type McpToolExecutionOutcome, type McpToolExecutionPayload } from '../../src/commands/mcp.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('commands/mcp task runtime', () => {
  it('runs tools serially and preserves queue order', async () => {
    const started: JsonRpcId[] = [];
    const completed: JsonRpcId[] = [];
    const first = deferred<McpToolExecutionOutcome>();
    const second = deferred<McpToolExecutionOutcome>();

    const runner = new McpTaskRunner({
      executeTool: (payload) => {
        started.push(payload.args.requestId as JsonRpcId);
        return payload.args.requestId === 1 ? first.promise : second.promise;
      },
      onResult: (requestId) => completed.push(requestId),
      onInternalError: () => assert.fail('should not fail'),
    });

    runner.enqueue(1, { name: 'tool', args: { requestId: 1 }, cwd: process.cwd() });
    runner.enqueue(2, { name: 'tool', args: { requestId: 2 }, cwd: process.cwd() });
    await tick();

    assert.deepEqual(started, [1]);
    first.resolve({ response: { content: [{ type: 'text', text: 'one' }], isError: false, schema_version: '0.3.0' } });
    await tick();
    assert.deepEqual(started, [1, 2]);

    second.resolve({ response: { content: [{ type: 'text', text: 'two' }], isError: false, schema_version: '0.3.0' } });
    await tick();
    assert.deepEqual(completed, [1, 2]);
  });

  it('cancels queued requests without producing a response', async () => {
    const completed: JsonRpcId[] = [];
    const first = deferred<McpToolExecutionOutcome>();

    const runner = new McpTaskRunner({
      executeTool: (payload) => payload.args.requestId === 1
        ? first.promise
        : Promise.resolve({ response: { content: [{ type: 'text', text: 'two' }], isError: false, schema_version: '0.3.0' } }),
      onResult: (requestId) => completed.push(requestId),
      onInternalError: () => assert.fail('should not fail'),
    });

    runner.enqueue(1, { name: 'tool', args: { requestId: 1 }, cwd: process.cwd() });
    runner.enqueue(2, { name: 'tool', args: { requestId: 2 }, cwd: process.cwd() });
    assert.equal(runner.cancel(2), 'queued');

    first.resolve({ response: { content: [{ type: 'text', text: 'one' }], isError: false, schema_version: '0.3.0' } });
    await tick();
    assert.deepEqual(completed, [1]);
  });

  it('cancels active requests and allows the next queued request to run', async () => {
    const completed: JsonRpcId[] = [];
    const started: JsonRpcId[] = [];

    const runner = new McpTaskRunner({
      executeTool: (payload, signal) => {
        started.push(payload.args.requestId as JsonRpcId);
        if (payload.args.requestId === 2) {
          return Promise.resolve({
            response: { content: [{ type: 'text', text: 'two' }], isError: false, schema_version: '0.3.0' },
          });
        }
        return new Promise<McpToolExecutionOutcome>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      onResult: (requestId) => completed.push(requestId),
      onInternalError: () => assert.fail('cancelled task should not surface as internal error'),
    });

    runner.enqueue(1, { name: 'tool', args: { requestId: 1 }, cwd: process.cwd() });
    runner.enqueue(2, {
      name: 'tool',
      args: { requestId: 2 },
      cwd: process.cwd(),
    });
    await tick();

    assert.equal(runner.cancel(1), 'active');
    await tick();
    await tick();
    assert.deepEqual(started, [1, 2]);
    assert.deepEqual(completed, [2]);
  });
});
