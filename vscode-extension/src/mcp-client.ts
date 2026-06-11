/**
 * Lightweight MCP stdio client for the Brainclaw VS Code extension.
 *
 * Spawns `brainclaw mcp` and communicates over JSON-RPC 2.0 (newline-delimited).
 * One instance per project directory.
 */
import * as cp from 'child_process';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolsCallResult {
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class McpClient {
  private _process: cp.ChildProcess | null = null;
  private _pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private _nextId = 1;
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;
  private _buffer = '';
  private _dead = false;

  constructor(
    private readonly _cwd: string,
    private readonly _bclawCmd: string,
  ) {}

  /** Ensure the MCP server is started and initialized. */
  async ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._start();
    return this._initPromise;
  }

  /** Call an MCP tool. Returns the tool's structuredContent (falls back to parsing content[0].text). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.ensureInitialized();
    const result = await this._request('tools/call', { name, arguments: args }) as McpToolsCallResult;
    if (result?.isError) {
      const errText = result.content?.[0]?.text ?? 'Unknown MCP tool error';
      throw new Error(errText);
    }
    if (result?.structuredContent && typeof result.structuredContent === 'object') {
      return result.structuredContent as Record<string, unknown>;
    }
    // Fallback: try to parse the text content as JSON
    const text = result?.content?.[0]?.text;
    if (text) {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON response — return a wrapper
        return { text };
      }
    }
    return {};
  }

  /** Kill the MCP server process and clean up pending requests. */
  dispose(): void {
    this._dead = true;
    if (this._process) {
      try { this._process.kill(); } catch { /* ignore */ }
      this._process = null;
    }
    this._initialized = false;
    this._initPromise = null;
    for (const pending of this._pendingRequests.values()) {
      pending.reject(new Error('MCP client disposed'));
    }
    this._pendingRequests.clear();
    this._buffer = '';
  }

  private async _start(): Promise<void> {
    if (this._dead) throw new Error('MCP client is disposed');

    const [cmd, ...args] = this._buildSpawnArgs();
    this._process = cp.spawn(cmd, args, {
      cwd: this._cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // BRAINCLAW_OBSERVER=1: the VS Code extension is a dashboard, not an
      // agent. The server-side observer mode (src/core/observer-mode.ts)
      // suppresses every read-path side effect — autoAcknowledge, lazy
      // agent_run reconciliation, cursor advancement, implicit identity
      // registration — so polling the board never mutates the store. Also
      // strip BRAINCLAW_AGENT* so the extension cannot inherit the parent
      // shell's identity and consume that agent's cursor.
      env: this._spawnEnv(),
    });

    this._process.stderr?.on('data', () => { /* drain stderr */ });

    this._process.stdout?.on('data', (data: Buffer) => {
      this._buffer += data.toString('utf-8');
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this._handleMessage(JSON.parse(line) as JsonRpcResponse);
        } catch {
          // ignore malformed lines
        }
      }
    });

    this._process.on('error', (err) => {
      this._rejectAll(err);
      this._initialized = false;
      this._initPromise = null;
    });

    this._process.on('exit', () => {
      this._rejectAll(new Error('MCP server process exited'));
      this._initialized = false;
      this._initPromise = null;
      this._process = null;
    });

    // MCP initialization handshake
    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'brainclaw-vscode', version: '0.1.0' },
    });

    this._sendNotification('notifications/initialized', {});
    this._initialized = true;
  }

  private _handleMessage(msg: JsonRpcResponse): void {
    if (typeof msg.id !== 'number') return; // skip notifications
    const pending = this._pendingRequests.get(msg.id);
    if (!pending) return;
    this._pendingRequests.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message ?? 'MCP error'));
    } else {
      pending.resolve(msg.result);
    }
  }

  private _request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const TIMEOUT_MS = 15_000;
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, TIMEOUT_MS);
      this._pendingRequests.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        this._process?.stdin?.write(JSON.stringify(msg) + '\n', 'utf-8');
      } catch (err) {
        clearTimeout(timer);
        this._pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private _sendNotification(method: string, params: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    try {
      this._process?.stdin?.write(JSON.stringify(msg) + '\n', 'utf-8');
    } catch {
      // ignore
    }
  }

  private _rejectAll(err: Error): void {
    for (const pending of this._pendingRequests.values()) {
      pending.reject(err);
    }
    this._pendingRequests.clear();
  }

  private _spawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, BRAINCLAW_OBSERVER: '1' };
    // Strip parent-shell agent identity so the MCP server never resolves to
    // the agent whose terminal launched VS Code (otherwise the extension's
    // polling consumes that agent's event-log cursor and runtime state).
    delete env.BRAINCLAW_AGENT;
    delete env.BRAINCLAW_AGENT_ID;
    delete env.BRAINCLAW_AGENT_NAME;
    return env;
  }

  /**
   * Build [command, ...args] from the brainclaw command string (e.g. `brainclaw`,
   * `"path/to/brainclaw"`, or `node "path/to/dist/cli.js"`).
   */
  private _buildSpawnArgs(): [string, ...string[]] {
    const cmd = this._bclawCmd.trim();
    if (cmd.startsWith('node ')) {
      const script = cmd.slice(5).replace(/^"|"$/g, '');
      return ['node', script, 'mcp'];
    }
    // Strip wrapping quotes from paths like `"/path/to/brainclaw"`
    const bin = cmd.replace(/^"|"$/g, '');
    return [bin, 'mcp'];
  }
}
