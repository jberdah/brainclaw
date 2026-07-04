/**
 * Lightweight MCP stdio client for the Brainclaw VS Code extension.
 *
 * Spawns `brainclaw mcp` and communicates over JSON-RPC 2.0 (newline-delimited).
 * One instance per project directory.
 *
 * The command to spawn is passed in as a structured `BrainclawSpawnPlan` — see
 * `./brainclaw-resolver`. The plan is always shaped as `node <cli.js>` so
 * `cp.spawn(..., { shell: false })` works uniformly on win32 and POSIX
 * (never a `.cmd` shim — trp#927, 2026-07-03).
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { brainclawSpawnOptions, type BrainclawSpawnPlan } from './brainclaw-resolver';

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
    private readonly _plan: BrainclawSpawnPlan,
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
    this._process = cp.spawn(cmd, args, brainclawSpawnOptions(this._cwd));

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
      clientInfo: { name: 'brainclaw-vscode', version: readExtensionVersion() },
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

  /**
   * Build [command, ...args] from the resolved spawn plan.
   *
   * The plan is always `node <cli.js>` shape, so the resulting spawn call
   * works under `{ shell: false }` on every OS — no `.cmd`/`.ps1` shims are
   * handed to spawn (which would break on win32 with modern Node, see the
   * ENOENT trap that motivated `brainclaw-resolver.ts`).
   */
  private _buildSpawnArgs(): [string, ...string[]] {
    return [this._plan.command, ...this._plan.args, 'mcp'];
  }
}

function readExtensionVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}
