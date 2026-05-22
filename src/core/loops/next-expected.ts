/**
 * `computeNextExpected` — self-describing hint to the caller about the most
 * natural next intent for a given loop state.
 *
 * Used by:
 * - The MCP `bclaw_loop` facade (`src/commands/loops-handlers.ts`) on every
 *   mutating intent response.
 * - The CLI `brainclaw reply` command (`src/commands/reply.ts`) after
 *   resolving an operator_question, to tell the operator what to do next.
 *
 * Previously duplicated between those two call sites (pln#508 step 4
 * worker had to re-implement because they were dispatched to a separate
 * worktree and couldn't import from the other branch). Hoisted here per
 * candidate `can_e57c7782` so both surfaces share the SAME contract.
 *
 * Kept conservative: we look at the loop's status + open_questions + slot
 * states and pick the smallest correct action. No speculative reasoning
 * about future iterations or auto-close.
 */
import type { LoopPhase, LoopSlot, LoopThread } from './types.js';

export interface NextExpectedHint {
  action: 'turn' | 'complete_turn' | 'provide_input' | 'advance' | 'close';
  intent: string;
  reason?: string;
  phase?: string;
  slot_id?: string;
  role?: string;
  from_phase?: string;
  to_phase?: string;
  blocking_on: string[];
}

export function computeNextExpected(loop: LoopThread): NextExpectedHint | null {
  if (loop.status === 'completed' || loop.status === 'cancelled' || loop.status === 'blocked') {
    return null;
  }

  // pln#508 step 3 fix from codex review (loop-handlers.ts:252): paused
  // loops with open operator_questions should hint provide_input, not
  // advance/close. open_questions check fires regardless of status so it
  // also catches the slot-scope case where loop.status === 'open' but a
  // slot is in waiting_input.
  if (loop.open_questions.length > 0) {
    return {
      action: 'provide_input',
      intent: 'bclaw_loop.provide_input',
      reason: loop.status === 'paused' ? loop.pause_reason : 'awaiting_operator',
      blocking_on: [...loop.open_questions],
    };
  }

  if (loop.status === 'paused') {
    return null;
  }

  const currentPhaseSlots: LoopSlot[] = loop.slots.filter(
    (s) => (s.phase ?? loop.current_phase) === loop.current_phase,
  );

  const openSlots = currentPhaseSlots.filter((s) => s.status === 'open');
  if (openSlots.length > 0) {
    const first = openSlots[0];
    return {
      action: 'turn',
      intent: 'bclaw_loop.turn',
      phase: loop.current_phase,
      slot_id: first.slot_id,
      role: first.role,
      blocking_on: openSlots.map((s) => s.slot_id),
    };
  }

  const assignedOrWorking = currentPhaseSlots.filter(
    (s) => s.status === 'assigned' || s.status === 'working',
  );
  if (assignedOrWorking.length > 0) {
    return {
      action: 'complete_turn',
      intent: 'bclaw_loop.complete_turn',
      phase: loop.current_phase,
      slot_id: assignedOrWorking[0].slot_id,
      role: assignedOrWorking[0].role,
      blocking_on: assignedOrWorking.map((s) => s.slot_id),
    };
  }

  const phaseNames: string[] = loop.phases.map((p: LoopPhase) => p.name);
  const currentIndex = phaseNames.indexOf(loop.current_phase);
  if (currentIndex >= 0 && currentIndex + 1 < phaseNames.length) {
    return {
      action: 'advance',
      intent: 'bclaw_loop.advance',
      from_phase: loop.current_phase,
      to_phase: phaseNames[currentIndex + 1],
      blocking_on: [],
    };
  }

  return {
    action: 'close',
    intent: 'bclaw_loop.close',
    reason: 'terminal_phase_reached',
    blocking_on: [],
  };
}
