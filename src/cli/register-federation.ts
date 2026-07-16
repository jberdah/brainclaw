import type { Command } from 'commander';

export function registerFederationCommands(program: Command): void {
  // --- federation cloud ---
  const federationCmd = program
    .command('federation')
    .description('Cloud federation — sync signals with app.brainclaw.dev');

  federationCmd
    .command('push <message>')
    .description('Push a test signal to the cloud')
    .option('--type <type>', 'Signal type', 'runtime_note')
    .option('--to-project <project>', 'Target project name')
    .option('--to-agent <agent>', 'Target agent name')
    .action(async (message: string, options) => {
      const { pushSignalToCloud, isCloudConfigured } = await import('../core/federation-cloud.js');
      const { createFederationMessage } = await import('../core/federation-message.js');
      const { loadConfig } = await import('../core/config.js');
      const { resolveCurrentAgentName } = await import('../core/agent-registry.js');

      if (!isCloudConfigured()) {
        console.error('Error: cloud not configured. Set BRAINCLAW_CLOUD_API_KEY env var.');
        process.exit(1);
      }

      const config = loadConfig();
      const agent = resolveCurrentAgentName() ?? 'unknown';
      const msg = createFederationMessage({
        version: 1,
        from: { project_name: config.project_name, project_path: process.cwd(), agent_name: agent },
        to: {
          project_name: options.toProject ?? 'broadcast',
          project_path: '',
          // Wire --to-agent into the message (was declared but dropped, so every
          // push went out as a broadcast with to_agent NULL — found during the
          // cross-machine E2E, pln#365). Omitted → undefined → broadcast, as before.
          ...(options.toAgent ? { agent_name: options.toAgent as string } : {}),
        },
        type: options.type as 'signal' | 'handoff' | 'candidate' | 'runtime_note' | 'board_snapshot',
        payload: { text: message },
      });

      const ok = await pushSignalToCloud(msg);
      if (ok) {
        console.log(`✔ Signal pushed to cloud: [${msg.id}] ${message}`);
      } else {
        console.error('Error: failed to push signal to cloud.');
        process.exit(1);
      }
    });

  federationCmd
    .command('pull')
    .description('Pull signals from the cloud inbox')
    .option('--agent <name>', 'Agent name to pull for')
    .option('--since <date>', 'Only pull signals after this ISO date')
    .option('--limit <n>', 'Max signals to pull', '20')
    .action(async (options) => {
      const { pullSignalsFromCloud, isCloudConfigured } = await import('../core/federation-cloud.js');
      const { resolveCurrentAgentName } = await import('../core/agent-registry.js');

      if (!isCloudConfigured()) {
        console.error('Error: cloud not configured. Set BRAINCLAW_CLOUD_API_KEY env var.');
        process.exit(1);
      }

      const agent = options.agent ?? resolveCurrentAgentName() ?? 'unknown';
      const signals = await pullSignalsFromCloud(agent, {
        since: options.since,
        limit: parseInt(options.limit, 10),
      });

      if (signals.length === 0) {
        console.log('No signals in cloud inbox.');
        return;
      }

      console.log(`${signals.length} signal(s) from cloud:\n`);
      for (const s of signals) {
        const payload = typeof s.payload === 'object' && s.payload !== null ? (s.payload as Record<string, unknown>).text ?? JSON.stringify(s.payload) : String(s.payload);
        console.log(`  [${s.id}] ${s.type} from ${s.from.project_name}/${s.from.agent_name}`);
        console.log(`    ${String(payload).slice(0, 120)}`);
        console.log(`    ${s.created_at}\n`);
      }
    });

  federationCmd
    .command('status')
    .description('Diagnose cloud federation: config, health, signing identity, approved agent')
    .action(async () => {
      const { diagnoseCloudBridge } = await import('../core/federation-cloud.js');
      const d = await diagnoseCloudBridge();

      const yn = (b: boolean) => (b ? 'yes' : 'no');
      console.log(`Cloud URL:   ${d.apiUrl}`);
      console.log(`API Key:     ${process.env.BRAINCLAW_CLOUD_API_KEY ? '***configured***' : (d.configured ? 'from config' : 'NOT SET')}`);
      console.log(`Configured:  ${yn(d.configured)}`);
      console.log(`Opted-in:    ${yn(d.enabled)}`);
      console.log(`Project:     ${d.projectId ?? '(none)'}`);
      console.log(`Require signed writes: ${yn(d.requireSigned)}`);

      if (d.health) {
        console.log(
          d.health.ok
            ? `Cloud status: ${d.health.status} (v${d.health.version})`
            : `Cloud unreachable: ${d.health.error ?? 'unknown error'}`,
        );
      }

      if (d.signing.available) {
        console.log('\nSigning identity:');
        console.log(`  Agent:       ${d.signing.agentName} [${d.signing.cloudAgentId}]`);
        console.log(`  Key present: yes`);
        console.log(`  Fingerprint: ${d.signing.fingerprint.slice(0, 16)}…`);
      } else {
        console.log(`\nSigning identity: unavailable — ${d.signing.reason}`);
      }

      if (d.approvedAgent) {
        console.log('\nApproved agent (cloud):');
        if (d.approvedAgent.found) {
          console.log(`  Status:      ${d.approvedAgent.status ?? '(unknown)'}`);
          console.log(`  Trust:       ${d.approvedAgent.trustLevel ?? '(unknown)'}`);
          console.log(
            `  Key match:   ${d.approvedAgent.fingerprintMatch ? 'yes ✔' : 'NO ✗ (local key does not match the registered key)'}`,
          );
        } else {
          console.log(`  Not found${d.approvedAgent.error ? ` — ${d.approvedAgent.error}` : ''}`);
        }
      }

      if (d.requireSigned && !d.signing.available) {
        console.log('\n⚠ require_signed is set but no signing identity is available — the bridge will refuse to push (fail-closed).');
      }
    });

  federationCmd
    .command('identity')
    .description('Show this agent\'s federation signing identity (public key to approve in the cloud UI)')
    .option('--agent <name>', 'Agent name (defaults to the current agent)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { resolveOrAutoRegisterAgentIdentity, ensureAgentSigningKey, resolveCurrentAgentName } =
        await import('../core/agent-registry.js');

      const agentName = (options.agent as string | undefined) ?? resolveCurrentAgentName();
      const { identity } = resolveOrAutoRegisterAgentIdentity({ agentName, cwd: process.cwd() });
      const key = ensureAgentSigningKey(identity.agent_id);

      if (options.json) {
        console.log(JSON.stringify({
          agent_name: identity.agent_name,
          local_agent_id: identity.agent_id,
          fingerprint: key.fingerprint,
          public_key_pem: key.publicKeyPem,
        }, null, 2));
        return;
      }

      console.log(`Agent name:     ${identity.agent_name}`);
      console.log(`Local agent id: ${identity.agent_id}`);
      console.log(`Fingerprint:    ${key.fingerprint}`);
      console.log('\nPublic key — paste into the cloud UI (project → Agents → Register / approve an agent):\n');
      console.log(key.publicKeyPem.trim());
      console.log('\nThen, on this machine, configure the bridge with the cloud agent id shown after approval:');
      console.log(`  export BRAINCLAW_AGENT_NAME=${identity.agent_name}`);
      console.log('  export BRAINCLAW_CLOUD_AGENT_ID=<agt_... returned by the UI>');
      console.log('  (plus BRAINCLAW_CLOUD_API_KEY, BRAINCLAW_PROJECT_ID) — then run `brainclaw federation status`.');
    });

  federationCmd
    .command('sync')
    .description('Drain the federation outbox — push signed claim upserts to the cloud')
    .option('--entity <type>', 'Entity type to sync (increment 1: claim)', 'claim')
    .option('--limit <n>', 'Max records to push this run')
    .option('--dry-run', 'Reconcile + list pending records without any network calls')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const outbox = await import('../core/federation-outbox.js');
      const { pushClaimToCloud, isCloudConfigured } = await import('../core/federation-cloud.js');
      const cwd = process.cwd();
      const PARK_AFTER = 5;

      const reconciled = outbox.reconcileOutbox(cwd);
      let records = outbox.listOutboxRecords(cwd);
      if (options.limit) records = records.slice(0, parseInt(options.limit as string, 10));

      const counts = { synced: 0, superseded: 0, parked: reconciled.parked, dropped: reconciled.dropped, retry: 0 };
      const lines: string[] = [];
      const emit = (line: string) => { lines.push(line); if (!options.json) console.log(line); };

      if (options.dryRun) {
        for (const r of records) emit(`pending ${r.record.entity_type} ${r.record.entity_id} r${r.record.rev} (${r.record.to_status})`);
        const out = { dry_run: true, reconciled, pending: records.length, records: lines };
        if (options.json) console.log(JSON.stringify(out, null, 2));
        else console.log(`\npending=${records.length} reconciled_dropped=${reconciled.dropped} reconciled_parked=${reconciled.parked}`);
        return;
      }

      if (!isCloudConfigured(cwd)) {
        console.error('Error: cloud not configured (set BRAINCLAW_CLOUD_API_KEY or cloud_sync). Records left in outbox.');
        process.exit(3);
      }

      let failClosed = false;
      for (const r of records) {
        const res = await pushClaimToCloud(r.record.payload, cwd);
        const tag = `${r.record.entity_id} r${r.record.rev}`;

        if (res.kind === 'not_configured' || res.kind === 'fail_closed') {
          failClosed = true;
          emit(`fail-closed ${tag} (${res.kind}) — not sent`);
          break; // same config for all remaining records
        }
        if (res.kind === 'network_error') {
          const attempts = r.record.attempts + 1;
          if (attempts >= PARK_AFTER) { outbox.parkRecord(r, `network error x${attempts}: ${res.error}`, cwd); counts.parked++; emit(`park  ${tag} (network x${attempts}: ${res.error})`); }
          else { outbox.recordAttempt(r, { http_status: null, error: res.error }, cwd); counts.retry++; emit(`retry ${tag} (network: ${res.error})`); }
          continue;
        }

        const { httpStatus, code } = res;
        if (httpStatus === 200 || httpStatus === 201) {
          outbox.archiveToSent(r, { http_status: httpStatus }, cwd); counts.synced++;
          emit(`pushed ${tag} → ${httpStatus}`);
        } else if (httpStatus === 409 && (code === 'STALE' || code === 'stale_version')) {
          outbox.archiveToSent(r, { http_status: httpStatus }, cwd); counts.superseded++;
          emit(`superseded ${tag} → 409 ${code} (cloud has a newer rev)`);
        } else if (httpStatus === 409) {
          outbox.parkRecord(r, `409 ${code ?? 'conflict'}`, cwd); counts.parked++;
          emit(`PARK  ${tag} → 409 ${code ?? 'conflict'} (divergence — inspect)`);
        } else if (httpStatus === 403) {
          outbox.parkRecord(r, `403 ${code ?? 'forbidden'}`, cwd); counts.parked++;
          emit(`PARK  ${tag} → 403 ${code ?? 'forbidden'}`);
        } else if (httpStatus >= 500) {
          const attempts = r.record.attempts + 1;
          if (attempts >= PARK_AFTER) { outbox.parkRecord(r, `5xx x${attempts} (last ${httpStatus})`, cwd); counts.parked++; emit(`park  ${tag} → ${httpStatus} (x${attempts})`); }
          else { outbox.recordAttempt(r, { http_status: httpStatus, error: null }, cwd); counts.retry++; emit(`retry ${tag} → ${httpStatus}`); }
        } else {
          outbox.parkRecord(r, `${httpStatus} ${code ?? 'client error'}`, cwd); counts.parked++;
          emit(`PARK  ${tag} → ${httpStatus} ${code ?? ''}`.trim());
        }
      }

      const summary = `synced=${counts.synced} superseded=${counts.superseded} retry=${counts.retry} parked=${counts.parked} dropped=${counts.dropped}`;
      if (options.json) console.log(JSON.stringify({ ...counts, fail_closed: failClosed, records: lines }, null, 2));
      else console.log(`\n${summary}`);

      if (failClosed) process.exit(3);
      if (counts.parked > 0) process.exit(2);
      if (counts.retry > 0) process.exit(1);
      // exit 0
    });
}
