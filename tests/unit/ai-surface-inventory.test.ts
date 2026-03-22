import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAiSurfaceInventory,
  renderAiSurfaceSummary,
  renderAiSurfaceUsageHints,
} from '../../src/core/ai-surface-inventory.js';

describe('buildAiSurfaceInventory', () => {
  it('detects ChatGPT Desktop on Windows through AppX package inventory', () => {
    const surfaces = buildAiSurfaceInventory({
      platform: 'win32',
      processNames: [],
      browsers: ['msedge'],
      windowsAppxPackages: [
        {
          name: 'OpenAI.ChatGPT-Desktop',
          version: '1.2026.43.0',
          installLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop',
        },
      ],
    });

    const chatgpt = surfaces.find((surface) => surface.product_name === 'chatgpt');
    assert.ok(chatgpt);
    assert.equal(chatgpt.surface_kind, 'desktop_ai_app');
    assert.equal(chatgpt.status, 'detected_install');
    assert.equal(chatgpt.install_source, 'appx');
    assert.equal(chatgpt.version, '1.2026.43.0');
  });

  it('detects Gemini CLI / Antigravity from the local footprint', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ai-surface-'));
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'antigravity'), { recursive: true });

    try {
      const surfaces = buildAiSurfaceInventory({
        homeDir: tmpHome,
        platform: 'linux',
        processNames: [],
        browsers: [],
      });

      const geminiCli = surfaces.find((surface) => surface.id === 'surf_gemini_cli_linux');
      assert.ok(geminiCli);
      assert.equal(geminiCli.surface_kind, 'cli_agent');
      assert.equal(geminiCli.status, 'brainclaw_ready');
      assert.equal(geminiCli.install_source, 'config_footprint');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('models Claude Cowork as an embedded capability of Claude Desktop', () => {
    const surfaces = buildAiSurfaceInventory({
      platform: 'darwin',
      processNames: ['Claude'],
      browsers: ['open'],
    });

    const claude = surfaces.find((surface) => surface.id === 'surf_claude_desktop_darwin');
    const cowork = surfaces.find((surface) => surface.id === 'surf_claude_cowork_darwin');
    assert.ok(claude);
    assert.ok(cowork);
    assert.equal(claude.status, 'detected_running');
    assert.equal(cowork.surface_kind, 'desktop_embedded_capability');
    assert.equal(cowork.parent_surface_id, claude.id);
    assert.equal(cowork.status, 'limited');
  });

  it('treats Gemini web as a limited web surface when a browser is available', () => {
    const surfaces = buildAiSurfaceInventory({
      platform: 'linux',
      processNames: [],
      browsers: ['firefox'],
    });

    const geminiWeb = surfaces.find((surface) => surface.id === 'surf_gemini_web_linux');
    assert.ok(geminiWeb);
    assert.equal(geminiWeb.surface_kind, 'web_surface');
    assert.equal(geminiWeb.status, 'limited');
    assert.match(geminiWeb.detection_sources.join(' '), /browser availability/i);
  });
});

describe('renderAiSurfaceSummary', () => {
  it('renders only detected or available surfaces', () => {
    const lines = renderAiSurfaceSummary([
      {
        id: 'surf_one',
        product_name: 'chatgpt',
        display_name: 'ChatGPT Desktop',
        surface_kind: 'desktop_ai_app',
        status: 'detected_install',
        running: false,
        detection_sources: ['AppX package'],
        supports_mcp: 'unknown',
        supports_remote_connectors: 'unknown',
        supports_local_config: 'limited',
        supports_context_export: 'yes',
        supports_prompt_bootstrap: 'yes',
        supports_safe_write_actions: 'limited',
        interactive_only: true,
        can_edit_code: false,
        recommended_uses: ['draft docs'],
      },
      {
        id: 'surf_two',
        product_name: 'claude',
        display_name: 'Claude Desktop',
        surface_kind: 'desktop_ai_app',
        status: 'not_detected',
        running: false,
        detection_sources: [],
        supports_mcp: 'yes',
        supports_remote_connectors: 'yes',
        supports_local_config: 'yes',
        supports_context_export: 'yes',
        supports_prompt_bootstrap: 'yes',
        supports_safe_write_actions: 'limited',
        interactive_only: true,
        can_edit_code: false,
        recommended_uses: ['repo synthesis'],
      },
    ]);

    assert.equal(lines[0], 'AI surfaces: 1/2 detected or available');
    assert.equal(lines.length, 2);
    assert.match(lines[1] ?? '', /ChatGPT Desktop/);
  });

  it('renders concise usage hints for detected surfaces', () => {
    const lines = renderAiSurfaceUsageHints([
      {
        id: 'surf_one',
        product_name: 'chatgpt',
        display_name: 'ChatGPT Desktop',
        surface_kind: 'desktop_ai_app',
        status: 'detected_install',
        running: false,
        detection_sources: ['AppX package'],
        supports_mcp: 'unknown',
        supports_remote_connectors: 'unknown',
        supports_local_config: 'limited',
        supports_context_export: 'yes',
        supports_prompt_bootstrap: 'yes',
        supports_safe_write_actions: 'limited',
        interactive_only: true,
        can_edit_code: false,
        recommended_uses: ['generate visual concepts', 'draft polished summaries', 'prepare launch copy'],
      },
    ]);

    assert.equal(lines[0], 'ChatGPT Desktop:');
    assert.equal(lines.length, 3);
    assert.match(lines[1] ?? '', /generate visual concepts/);
    assert.match(lines[2] ?? '', /draft polished summaries/);
  });
});
