import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function confirmAction(question: string, yes?: boolean): Promise<void> {
  if (yes) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`Error: ${question} Re-run with --yes in non-interactive mode.`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    if (answer.trim().toLowerCase() !== 'y') {
      console.error('Cancelled.');
      process.exit(1);
    }
  } catch (error: unknown) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}
