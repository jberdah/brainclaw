import https from 'node:https';

export interface PackageQuery {
  depname: string;
  ecosystem: 'npm' | 'pypi';
  version?: string;
}

export interface PackageScores {
  purl: string;
  version: string;
  supplyChain: number;
  vulnerability: number;
  quality: number;
  maintenance: number;
  license: number;
}

export interface SocketClientOptions {
  endpoint?: string;
  timeoutMs?: number;
}

const DEFAULT_ENDPOINT = 'https://mcp.socket.dev/';
const DEFAULT_TIMEOUT = 15_000;
const MCP_PROTOCOL_VERSION = '2024-11-05';

function post(url: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...headers },
      timeout: timeoutMs,
    }, res => {
      let data = '';
      res.on('data', (c: Buffer) => data += c.toString());
      res.on('end', () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') h[k] = v;
        }
        resolve({ status: res.statusCode ?? 0, headers: h, body: data });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Socket MCP request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseScoresFromText(text: string): PackageScores[] {
  const results: PackageScores[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('pkg:')) continue;
    const match = line.match(/^(pkg:\w+\/[^@]+)@([^:]+):\s*(.+)/);
    if (!match) continue;
    const [, purl, version, rest] = match;
    const scores: Record<string, number> = {};
    for (const pair of rest!.split(',')) {
      const [k, v] = pair.trim().split(':').map(s => s.trim());
      if (k && v) scores[k] = parseInt(v, 10);
    }
    results.push({
      purl: purl!,
      version: version!,
      supplyChain: scores['supplyChain'] ?? 0,
      vulnerability: scores['vulnerability'] ?? 0,
      quality: scores['quality'] ?? 0,
      maintenance: scores['maintenance'] ?? 0,
      license: scores['license'] ?? 0,
    });
  }
  return results;
}

export async function querySocketScores(packages: PackageQuery[], options: SocketClientOptions = {}): Promise<PackageScores[]> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;

  // Step 1: MCP initialize
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'brainclaw-security', version: '1.0.0' },
    },
    id: 1,
  });
  const initRes = await post(endpoint, initBody, {}, timeout);
  if (initRes.status !== 200) {
    throw new Error(`Socket MCP initialize failed: HTTP ${initRes.status}`);
  }
  const sessionId = initRes.headers['mcp-session-id'];
  if (!sessionId) {
    throw new Error('Socket MCP did not return a session ID');
  }

  // Step 2: Send initialized notification
  const notifBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await post(endpoint, notifBody, { 'mcp-session-id': sessionId }, timeout);

  // Step 3: Call depscore
  const callBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'depscore',
      arguments: { packages },
    },
    id: 2,
  });
  const callRes = await post(endpoint, callBody, { 'mcp-session-id': sessionId }, timeout);
  if (callRes.status !== 200) {
    throw new Error(`Socket MCP depscore failed: HTTP ${callRes.status}`);
  }

  const parsed = JSON.parse(callRes.body);
  if (parsed.error) {
    throw new Error(`Socket MCP error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }

  const content = parsed.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Socket MCP returned empty content');
  }

  const text = content[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Socket MCP returned non-text content');
  }

  return parseScoresFromText(text);
}
