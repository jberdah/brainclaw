import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import {
  isCloudConfigured,
  isCloudSyncEnabled,
  pushSignalToCloud,
  pullSignalsFromCloud,
} from '../../src/core/federation-cloud.js';
import { createFederationMessage, type FederationMessage } from '../../src/core/federation-message.js';

interface CapturedFetchCall {
  url: string;
  init?: RequestInit;
}

function installFetchMock(handler: (call: CapturedFetchCall) => Response): {
  calls: CapturedFetchCall[];
  restore: () => void;
} {
  const calls: CapturedFetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: CapturedFetchCall = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function clearCloudEnv(): { restore: () => void } {
  const saved = {
    key: process.env.BRAINCLAW_CLOUD_API_KEY,
    url: process.env.BRAINCLAW_CLOUD_URL,
  };
  delete process.env.BRAINCLAW_CLOUD_API_KEY;
  delete process.env.BRAINCLAW_CLOUD_URL;
  return {
    restore: () => {
      if (saved.key === undefined) delete process.env.BRAINCLAW_CLOUD_API_KEY;
      else process.env.BRAINCLAW_CLOUD_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.BRAINCLAW_CLOUD_URL;
      else process.env.BRAINCLAW_CLOUD_URL = saved.url;
    },
  };
}

describe('federation-cloud', () => {
  let workspace: TestWorkspace;
  let envReset: { restore: () => void };

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    envReset = clearCloudEnv();
    workspace = createTestWorkspace({ prefix: 'bclaw-cloud-' });
  });

  afterEach(() => {
    envReset.restore();
    workspace.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
  });

  describe('isCloudConfigured + isCloudSyncEnabled', () => {
    it('returns false by default (no env, no config.cloud_sync)', () => {
      assert.equal(isCloudConfigured(workspace.dir), false);
      assert.equal(isCloudSyncEnabled(workspace.dir), false);
    });

    it('env BRAINCLAW_CLOUD_API_KEY implies explicit opt-in', () => {
      process.env.BRAINCLAW_CLOUD_API_KEY = 'env-key';
      assert.equal(isCloudConfigured(workspace.dir), true);
      assert.equal(isCloudSyncEnabled(workspace.dir), true);
    });

    it('config api_key alone is not enough — enabled flag required', () => {
      workspace.updateConfig((c) => {
        c.cloud_sync = { enabled: false, endpoint: 'https://app.brainclaw.dev', api_key: 'config-key' };
      });
      assert.equal(isCloudConfigured(workspace.dir), true);
      assert.equal(isCloudSyncEnabled(workspace.dir), false);
    });

    it('config api_key + enabled=true → opted in', () => {
      workspace.updateConfig((c) => {
        c.cloud_sync = { enabled: true, endpoint: 'https://app.brainclaw.dev', api_key: 'config-key' };
      });
      assert.equal(isCloudConfigured(workspace.dir), true);
      assert.equal(isCloudSyncEnabled(workspace.dir), true);
    });

    it('cloud_sync.enabled=true without api_key still returns false', () => {
      workspace.updateConfig((c) => {
        c.cloud_sync = { enabled: true, endpoint: 'https://app.brainclaw.dev' };
      });
      assert.equal(isCloudConfigured(workspace.dir), false);
      assert.equal(isCloudSyncEnabled(workspace.dir), false);
    });
  });

  describe('pushSignalToCloud', () => {
    function makeSignal(): FederationMessage {
      return createFederationMessage({
        version: 1,
        from: { project_name: 'test-project', project_path: workspace.dir, agent_name: 'tester' },
        to: { project_name: 'broadcast', project_path: '' },
        type: 'runtime_note',
        payload: { text: 'hello cloud' },
      });
    }

    it('returns false (no-op) when cloud is not configured', async () => {
      const mock = installFetchMock(() => new Response(null, { status: 500 }));
      try {
        const ok = await pushSignalToCloud(makeSignal(), workspace.dir);
        assert.equal(ok, false);
        assert.equal(mock.calls.length, 0, 'fetch should not be called when no cloud config');
      } finally {
        mock.restore();
      }
    });

    it('POSTs the message to /api/v1/messages with the api key header', async () => {
      process.env.BRAINCLAW_CLOUD_API_KEY = 'env-key';
      process.env.BRAINCLAW_CLOUD_URL = 'https://example.invalid';
      const mock = installFetchMock(() => new Response(null, { status: 200 }));
      try {
        const signal = makeSignal();
        const ok = await pushSignalToCloud(signal, workspace.dir);
        assert.equal(ok, true);
        assert.equal(mock.calls.length, 1);
        const call = mock.calls[0];
        assert.equal(call.url, 'https://example.invalid/api/v1/messages');
        assert.equal(call.init?.method, 'POST');
        const headers = (call.init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers['X-API-Key'], 'env-key');
        assert.equal(headers['Content-Type'], 'application/json');
        const body = JSON.parse(call.init?.body as string);
        assert.equal(body.id, signal.id);
        assert.equal(body.type, 'runtime_note');
      } finally {
        mock.restore();
      }
    });

    it('returns false when cloud returns non-2xx', async () => {
      process.env.BRAINCLAW_CLOUD_API_KEY = 'env-key';
      const mock = installFetchMock(() => new Response(null, { status: 500 }));
      try {
        const ok = await pushSignalToCloud(makeSignal(), workspace.dir);
        assert.equal(ok, false);
      } finally {
        mock.restore();
      }
    });

    it('returns false when fetch throws', async () => {
      process.env.BRAINCLAW_CLOUD_API_KEY = 'env-key';
      const original = globalThis.fetch;
      globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
      try {
        const ok = await pushSignalToCloud(makeSignal(), workspace.dir);
        assert.equal(ok, false);
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe('pullSignalsFromCloud', () => {
    it('returns [] when cloud is not configured', async () => {
      const mock = installFetchMock(() => new Response(null, { status: 500 }));
      try {
        const signals = await pullSignalsFromCloud('tester', { limit: 10 }, workspace.dir);
        assert.deepEqual(signals, []);
        assert.equal(mock.calls.length, 0);
      } finally {
        mock.restore();
      }
    });

    it('GETs /api/v1/inbox/:agent with the since/limit query params', async () => {
      process.env.BRAINCLAW_CLOUD_API_KEY = 'env-key';
      process.env.BRAINCLAW_CLOUD_URL = 'https://example.invalid';
      const message = createFederationMessage({
        version: 1,
        from: { project_name: 'other', project_path: '/other', agent_name: 'remote' },
        to: { project_name: 'mine', project_path: workspace.dir, agent_name: 'tester' },
        type: 'runtime_note',
        payload: { text: 'incoming' },
      });
      const mock = installFetchMock(() =>
        new Response(JSON.stringify({ messages: [message] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      try {
        const signals = await pullSignalsFromCloud(
          'tester',
          { since: '2026-05-15T00:00:00Z', limit: 50 },
          workspace.dir,
        );
        assert.equal(signals.length, 1);
        assert.equal(signals[0].id, message.id);
        assert.equal(mock.calls.length, 1);
        const url = mock.calls[0].url;
        assert.ok(url.startsWith('https://example.invalid/api/v1/inbox/tester?'));
        assert.ok(url.includes('since=2026-05-15T00%3A00%3A00Z'));
        assert.ok(url.includes('limit=50'));
        const headers = (mock.calls[0].init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers['X-API-Key'], 'env-key');
      } finally {
        mock.restore();
      }
    });

    it('returns [] when cloud returns non-2xx', async () => {
      process.env.BRAINCLAW_CLOUD_API_KEY = 'env-key';
      const mock = installFetchMock(() => new Response(null, { status: 503 }));
      try {
        const signals = await pullSignalsFromCloud('tester', undefined, workspace.dir);
        assert.deepEqual(signals, []);
      } finally {
        mock.restore();
      }
    });

    it('returns [] when fetch throws', async () => {
      process.env.BRAINCLAW_CLOUD_API_KEY = 'env-key';
      const original = globalThis.fetch;
      globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
      try {
        const signals = await pullSignalsFromCloud('tester', undefined, workspace.dir);
        assert.deepEqual(signals, []);
      } finally {
        globalThis.fetch = original;
      }
    });
  });
});
