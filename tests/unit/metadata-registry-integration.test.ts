import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCapability } from '../../src/commands/capability.js';
import { runTool } from '../../src/commands/tool.js';
import { runExplore } from '../../src/commands/explore.js';
import { handleMcpReadToolCall } from '../../src/commands/mcp.js';
import { loadState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function captureConsole(fn: () => void): { logs: string[]; errors: string[] } {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };

  try {
    fn();
    return { logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('metadata registry integration', () => {
  const originalCwd = process.cwd();
  let workspace: TestWorkspace;
  let outsideDir: string;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-metadata-registry-',
      projectId: 'prj_metadata_test',
    });
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-metadata-outside-'));
    process.chdir(outsideDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(outsideDir, { recursive: true, force: true });
    workspace.cleanup();
  });

  it('creates and lists capabilities via CLI', () => {
    const { errors } = captureConsole(() => {
      runCapability('add', ['Performance Monitoring', 'Tracks system performance metrics'], { cwd: workspace.dir });
      runCapability('add', ['Security Scanning', 'Scans for security vulnerabilities'], { tag: ['security'], cwd: workspace.dir });
    });
    assert.equal(errors.length, 0);

    const state = loadState(workspace.dir);
    const capabilities = state.recent_decisions.filter((d) => d.tags.includes('capability'));
    assert.equal(capabilities.length, 2);
    assert.ok(capabilities.some((c) => c.text.includes('Performance Monitoring')));
    assert.ok(capabilities.some((c) => c.text.includes('Security Scanning')));
  });

  it('creates and lists tools via CLI', () => {
    const { errors } = captureConsole(() => {
      runTool('add', ['npm-runner', 'Runs npm scripts with environment control'], { type: 'workflow', cwd: workspace.dir });
      runTool('add', ['linter', 'Code linting and formatting tool'], { type: 'validator', tag: ['code-quality'], cwd: workspace.dir });
    });
    assert.equal(errors.length, 0);

    const state = loadState(workspace.dir);
    const tools = state.recent_decisions.filter((d) => d.tags.includes('tool'));
    assert.equal(tools.length, 2);
    assert.ok(tools.some((t) => t.text.includes('npm-runner')));
    assert.ok(tools.some((t) => t.text.includes('linter')));
  });

  it('discover capabilities via explore command', () => {
    captureConsole(() => {
      runCapability('add', ['API Design', 'Designs REST and GraphQL APIs'], { tag: ['architecture'], cwd: workspace.dir });
      runCapability('add', ['Database Schema', 'Defines database schema design'], { tag: ['architecture'], cwd: workspace.dir });
    });

    const { logs } = captureConsole(() => {
      runExplore({ cwd: workspace.dir });
    });
    const output = logs.join('\n');
    assert.ok(output.includes('Capabilities'));
    assert.ok(output.includes('API Design'));
    assert.ok(output.includes('Database Schema'));
  });

  it('discover tools via explore command', () => {
    captureConsole(() => {
      runTool('add', ['test-runner', 'Executes unit tests'], { type: 'validator', cwd: workspace.dir });
      runTool('add', ['build-tool', 'Builds the project'], { type: 'generator', cwd: workspace.dir });
    });

    const { logs } = captureConsole(() => {
      runExplore({ cwd: workspace.dir });
    });
    const output = logs.join('\n');
    assert.ok(output.includes('Tools'));
    assert.ok(output.includes('test-runner'));
    assert.ok(output.includes('build-tool'));
  });

  it('gets capabilities via MCP tool', () => {
    captureConsole(() => {
      runCapability('add', ['Cache Management', 'Manages application caching'], { tag: ['performance'], cwd: workspace.dir });
      runCapability('add', ['Logging', 'Centralized logging system'], { tag: ['reliability'], cwd: workspace.dir });
    });

    const response = handleMcpReadToolCall('bclaw_get_capabilities', {}, { cwd: workspace.dir });
    assert.ok(response.content);
    const text = response.content[0]?.text || '';
    assert.ok(text.includes('Capabilities'));
    assert.ok(text.includes('Cache Management'));
    assert.ok(text.includes('Logging'));

    const structured = response.structuredContent as Record<string, unknown>;
    const capabilities = structured.capabilities || structured.available_capabilities;
    assert.ok(Array.isArray(capabilities));
    assert.equal((capabilities as unknown[]).length, 2);
  });

  it('lists tools via MCP tool with filtering', () => {
    captureConsole(() => {
      runTool('add', ['TypeScript Compiler', 'Compiles TypeScript to JavaScript'], { type: 'generator', cwd: workspace.dir });
      runTool('add', ['ESLint', 'JavaScript linting tool'], { type: 'validator', cwd: workspace.dir });
      runTool('add', ['Docker Builder', 'Builds Docker images'], { type: 'workflow', cwd: workspace.dir });
    });

    const response = handleMcpReadToolCall('bclaw_list_tools', { type: 'validator' }, { cwd: workspace.dir });
    const structured = response.structuredContent as Record<string, unknown>;
    const tools = structured.tools || [];
    assert.ok(Array.isArray(tools));
    assert.equal((tools as unknown[]).length, 1);

    const toolText = response.content[0]?.text || '';
    assert.ok(toolText.includes('ESLint'));
    assert.ok(!toolText.includes('Docker Builder'));
  });

  it('searches tools via MCP tool', () => {
    captureConsole(() => {
      runTool('add', ['Docker Builder', 'Builds Docker containers'], { type: 'workflow', tag: ['containers'], cwd: workspace.dir });
      runTool('add', ['Kubernetes Deploy', 'Deploys to Kubernetes'], { type: 'workflow', cwd: workspace.dir });
      runTool('add', ['npm installer', 'Installs npm packages'], { type: 'utility', cwd: workspace.dir });
    });

    const response = handleMcpReadToolCall('bclaw_search_tools', { query: 'docker' }, { cwd: workspace.dir });
    const structured = response.structuredContent as Record<string, unknown>;
    assert.ok(Array.isArray(structured.tools));
    assert.equal((structured.tools as unknown[]).length, 1);

    const toolText = response.content[0]?.text || '';
    assert.ok(toolText.includes('Docker'));
  });

  it('enrich context includes capability and tool suggestions', () => {
    captureConsole(() => {
      runCapability('add', ['Request Validation', 'Validates incoming HTTP requests'], { tag: ['security'], cwd: workspace.dir });
      runTool('add', ['Validator Middleware', 'Middleware for request validation'], { type: 'utility', cwd: workspace.dir });
    });

    const response = handleMcpReadToolCall('bclaw_get_context', { path: 'src/api' }, { cwd: workspace.dir });
    assert.ok(response.content);
    const text = response.content[0]?.text || '';
    assert.ok(text.includes('Available Capabilities') || text.includes('Available Tools'));

    const structured = response.structuredContent as Record<string, unknown>;
    assert.ok(Array.isArray(structured.available_capabilities));
    assert.ok(Array.isArray(structured.available_tools));
  });

  it('handles empty registries gracefully', () => {
    const response = handleMcpReadToolCall('bclaw_get_capabilities', {}, { cwd: workspace.dir });
    const structured = response.structuredContent as Record<string, unknown>;
    const capabilities = structured.capabilities || structured.available_capabilities || [];
    assert.ok(Array.isArray(capabilities));
    assert.equal((capabilities as unknown[]).length, 0);

    const toolResponse = handleMcpReadToolCall('bclaw_list_tools', {}, { cwd: workspace.dir });
    const toolStructured = toolResponse.structuredContent as Record<string, unknown>;
    const tools = toolStructured.tools || [];
    assert.ok(Array.isArray(tools));
    assert.equal((tools as unknown[]).length, 0);
  });

  it('capability describe shows full details', () => {
    const addOutput = captureConsole(() => {
      runCapability('add', ['Audit Logging', 'Logs all system events for audit trails'], { tag: ['compliance'], cwd: workspace.dir });
    });

    const capId = addOutput.logs[0]?.match(/\[([a-z0-9_]+)\]/)?.[1];
    assert.ok(capId);

    const { logs } = captureConsole(() => {
      runCapability('describe', [capId!], { cwd: workspace.dir });
    });
    const output = logs.join('\n');
    assert.ok(output.includes('Audit Logging'));
    assert.ok(output.includes('compliance'));
  });

  it('tool describe shows full details', () => {
    const addOutput = captureConsole(() => {
      runTool('add', ['Git Sync', 'Synchronizes Git repositories'], { type: 'workflow', tag: ['vcs'], cwd: workspace.dir });
    });

    const toolId = addOutput.logs[0]?.match(/\[([a-z0-9_]+)\]/)?.[1];
    assert.ok(toolId);

    const { logs } = captureConsole(() => {
      runTool('describe', [toolId!], { cwd: workspace.dir });
    });
    const output = logs.join('\n');
    assert.ok(output.includes('Git Sync'));
    assert.ok(output.includes('workflow'));
  });

  it('tool search filters by tags', () => {
    captureConsole(() => {
      runTool('add', ['Analyzer Pro', 'Advanced code analysis'], { type: 'explorer', tag: ['analysis', 'quality'], cwd: workspace.dir });
      runTool('add', ['Test Runner', 'Runs unit tests'], { type: 'validator', tag: ['testing'], cwd: workspace.dir });
    });

    const response = handleMcpReadToolCall('bclaw_search_tools', { query: 'test', tags: ['testing'] }, { cwd: workspace.dir });
    const structured = response.structuredContent as Record<string, unknown>;
    assert.ok(Array.isArray(structured.tools));
    assert.equal((structured.tools as unknown[]).length, 1);
  });
});
