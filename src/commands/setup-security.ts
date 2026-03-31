import fs from 'node:fs';
import path from 'node:path';
import { memoryExists, memoryPath, ensureMemoryDir } from '../core/io.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { generateBashGuard, generatePowerShellGuard, generatePipBashGuard } from '../core/security-guard.js';

export interface SetupSecurityOptions {
  mode?: 'advisory' | 'enforced';
  cwd?: string;
}

export function runSetupSecurity(options: SetupSecurityOptions = {}): void {
  const cwd = options.cwd;

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const mode = options.mode ?? 'advisory';

  // Enable preinstall in config
  if (!config.security) {
    config.security = { mode: 'warn', strict_redaction: false, block_sensitive_paths: true };
  }
  config.security.preinstall = {
    enabled: true,
    mode,
    thresholds: {
      composite_pass: 70,
      composite_warn: 50,
      supply_chain_block: 30,
      vulnerability_block: 20,
    },
    weights: {
      supply_chain: 0.35,
      vulnerability: 0.30,
      quality: 0.15,
      maintenance: 0.15,
      license: 0.05,
    },
    cache_ttl_hours: 24,
    fallback_on_error: 'warn',
    allowlist: [],
    denylist: [],
    socket_endpoint: 'https://mcp.socket.dev/',
  };
  saveConfig(config, cwd);

  // Resolve brainclaw binary path
  const brainclawBin = resolveBrainclawBin(cwd);

  // Generate wrapper scripts
  const guardDir = memoryPath('security/bin', cwd);
  ensureMemoryDir(cwd);
  if (!fs.existsSync(guardDir)) {
    fs.mkdirSync(guardDir, { recursive: true });
  }

  // npm guard (bash)
  const npmBashPath = path.join(guardDir, 'npm');
  fs.writeFileSync(npmBashPath, generateBashGuard(brainclawBin), { mode: 0o755 });

  // npm guard (PowerShell)
  const npmPs1Path = path.join(guardDir, 'npm.ps1');
  fs.writeFileSync(npmPs1Path, generatePowerShellGuard(brainclawBin));

  // pip guard (bash)
  const pipBashPath = path.join(guardDir, 'pip');
  fs.writeFileSync(pipBashPath, generatePipBashGuard(brainclawBin), { mode: 0o755 });

  // pip guard (PowerShell)
  const pipPs1Path = path.join(guardDir, 'pip.ps1');
  fs.writeFileSync(pipPs1Path, generatePowerShellGuard(brainclawBin).replace(
    '} else { "npm" }',
    '} else { "pip" }',
  ));

  console.log(`\u2705 Security gate enabled (mode: ${mode})`);
  console.log('');
  console.log('Generated wrapper scripts:');
  console.log(`  ${npmBashPath}`);
  console.log(`  ${npmPs1Path}`);
  console.log(`  ${pipBashPath}`);
  console.log(`  ${pipPs1Path}`);
  console.log('');
  console.log('To activate, prepend the guard directory to your PATH:');
  console.log(`  export PATH="${guardDir}:$PATH"    # bash/zsh`);
  console.log(`  $env:PATH = "${guardDir};$env:PATH"  # PowerShell`);
  console.log('');
  console.log('Or add it to your shell profile for persistent activation.');
  console.log('');
  console.log(`Mode: ${mode}`);
  if (mode === 'advisory') {
    console.log('  Advisory mode: warnings and traps are created but installs are not blocked.');
    console.log('  Switch to enforced mode: brainclaw setup --security --mode enforced');
  } else {
    console.log('  Enforced mode: risky installs will be blocked (exit code 1).');
  }
}

function resolveBrainclawBin(cwd?: string): string {
  // Try to find brainclaw in common locations
  const candidates = [
    'brainclaw',
    path.resolve(cwd ?? process.cwd(), 'node_modules/.bin/brainclaw'),
    path.resolve(cwd ?? process.cwd(), 'dist/cli.js'),
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // continue
    }
  }

  // Default to just 'brainclaw' and hope it's in PATH
  return 'brainclaw';
}
