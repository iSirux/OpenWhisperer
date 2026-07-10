/**
 * Cockpit intent executor — maps parsed `CockpitIntent`s onto the existing
 * stores/machinery (sdkSessions, launchSession, pile, LLM helpers).
 *
 * Contracts:
 * - Every executed intent writes exactly one ledger entry; pending-confirm
 *   entries are updated in place when resolved (ok / cancelled / error).
 * - Destructive intents (stop_session, reject, dismiss_done) are two-step:
 *   they park in `pendingConfirm` with an 8s expiry and only run on a
 *   subsequent `confirm_yes`.
 * - All failures are caught → ledger 'error' + lastInterpretation ok:false.
 */

import { get } from 'svelte/store';
import {
  sdkSessions,
  type SdkSession,
  type PlanningAnswer,
  type EffortLevel,
} from '$lib/stores/sdkSessions';
import { settings } from '$lib/stores/settings';
import { repos, findRepoById, activeRepo, type RepoConfig } from '$lib/stores/repos';
import { pile } from '$lib/stores/pile';
import { launchSession, snapshotLaunchConfig } from '$lib/utils/sessionLaunch';
import { getProviderForModel, ALL_MODELS } from '$lib/utils/models';
import {
  cleanupTranscript,
  getRepoRecommendation,
  getModelRecommendation,
} from '$lib/composables/useTranscriptionProcessor.svelte';
import {
  describeIntent,
  normalizeUtterance,
  type CockpitIntent,
  type CockpitContext,
} from './commandGrammar';
import {
  appendLedger,
  updateLedger,
  setInterpretation,
  setDraft,
  clearDraft,
  patchDraftIf,
  dismissSessions,
  draft,
  pendingConfirm,
  focusedSessionId,
  fleetBriefing,
  type CockpitDraft,
  type FleetBriefing,
  type BriefingBlockedItem,
} from './cockpitStore';

/** How long a destructive action waits for a verbal "yes". */
export const CONFIRM_TIMEOUT_MS = 8000;

let confirmTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSession(id: string): SdkSession | undefined {
  return get(sdkSessions).find((s) => s.id === id);
}

function sessionLabel(session: SdkSession | undefined, ctx: CockpitContext): string {
  if (!session) return 'unknown session';
  const ref = ctx.sessions.find((r) => r.id === session.id);
  if (ref?.nickname) return ref.nickname;
  return session.aiMetadata?.nickname ?? session.aiMetadata?.name ?? (ref ? `#${ref.index}` : session.id);
}

/** Record a successful execution: ledger + interpretation. */
function recordOk(heard: string, intentLabel: string, resultLabel: string): void {
  appendLedger({ heard, intentLabel, resultLabel, status: 'ok' });
  setInterpretation(heard, intentLabel, true);
}

/** Record a visible failure (unknown / invalid state / error). */
function recordFail(
  heard: string,
  intentLabel: string,
  resultLabel: string,
  status: 'rejected' | 'error' = 'error'
): void {
  appendLedger({ heard, intentLabel, resultLabel, status });
  setInterpretation(heard, intentLabel, false);
}

/** First question index without a staged answer (multi-question flow). */
function firstUnansweredIndex(session: SdkSession): number {
  const q = session.askUserQuestion;
  if (!q) return -1;
  for (let i = 0; i < q.questions.length; i++) {
    if (!q.answers.some((a) => a.questionIndex === i)) return i;
  }
  return -1;
}

/** True when every question has a staged answer. */
function allQuestionsAnswered(session: SdkSession): boolean {
  const q = session.askUserQuestion;
  if (!q) return false;
  return q.questions.every((_, i) => q.answers.some((a) => a.questionIndex === i));
}

// ---------------------------------------------------------------------------
// Destructive-action confirm flow
// ---------------------------------------------------------------------------

function armConfirm(intent: CockpitIntent, heard: string, intentLabel: string): void {
  // A new pending confirm replaces (cancels) any previous one.
  const previous = get(pendingConfirm);
  if (previous) {
    updateLedger(previous.ledgerId, { status: 'cancelled', resultLabel: 'superseded' });
  }
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }

  const ledgerId = appendLedger({
    heard,
    intentLabel,
    resultLabel: 'say "yes" to confirm',
    status: 'pending-confirm',
  });
  const expiresAt = Date.now() + CONFIRM_TIMEOUT_MS;
  pendingConfirm.set({ intent, label: intentLabel, expiresAt, ledgerId });
  setInterpretation(heard, `${intentLabel} — confirm?`, true);

  confirmTimer = setTimeout(() => {
    const current = get(pendingConfirm);
    if (current && current.ledgerId === ledgerId) {
      pendingConfirm.set(null);
      updateLedger(ledgerId, { status: 'cancelled', resultLabel: 'confirmation timed out' });
    }
    confirmTimer = null;
  }, CONFIRM_TIMEOUT_MS);
}

/** Run the destructive intent that was parked behind the confirm. */
async function performDestructive(intent: CockpitIntent, ctx: CockpitContext): Promise<string> {
  switch (intent.type) {
    case 'stop_session': {
      const session = findSession(intent.sessionId);
      if (!session) throw new Error('Session no longer exists');
      await sdkSessions.stopQuery(intent.sessionId);
      return `stopped ${sessionLabel(session, ctx)}`;
    }
    case 'reject': {
      const session = findSession(intent.sessionId);
      if (!session) throw new Error('Session no longer exists');
      if (!session.pendingPlanApproval) {
        throw new Error(`${sessionLabel(session, ctx)} has no pending plan to reject`);
      }
      await sdkSessions.denyPlan(intent.sessionId, 'Plan rejected by voice from the cockpit.');
      return `rejected plan for ${sessionLabel(session, ctx)}`;
    }
    case 'dismiss_done': {
      const doneIds = ctx.sessions.filter((s) => s.isDone).map((s) => s.id);
      if (doneIds.length === 0) throw new Error('No finished sessions to dismiss');
      dismissSessions(doneIds);
      return `dismissed ${doneIds.length} finished session${doneIds.length === 1 ? '' : 's'}`;
    }
    default:
      throw new Error(`Intent ${intent.type} is not a confirmable action`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch draft flow
// ---------------------------------------------------------------------------

function createDraftFromText(text: string): CockpitDraft {
  return {
    transcript: text,
    rawTranscript: text,
    cleaning: true,
    recommendingRepo: true,
    recommendingModel: true,
    createdAt: Date.now(),
  };
}

/**
 * Kick best-effort background enrichment on a fresh draft: LLM cleanup,
 * repo recommendation, model/effort recommendation. Each result only applies
 * if the same draft is still open (guarded by `createdAt`), and only fills
 * fields the user hasn't already set by voice.
 */
function enrichDraft(d: CockpitDraft): void {
  const token = d.createdAt;
  const text = d.rawTranscript;

  void cleanupTranscript(text)
    .then((result) => {
      const current = get(draft);
      if (!current || current.createdAt !== token) return;
      patchDraftIf(token, {
        cleaning: false,
        // Only replace the transcript if the user hasn't appended since.
        transcript: current.transcript === current.rawTranscript ? result.text : current.transcript,
        wasCleanedUp: result.wasCleanedUp,
        cleanupCorrections: result.corrections,
      });
    })
    .catch(() => {
      patchDraftIf(token, { cleaning: false });
    });

  const repoList = get(repos).list;
  void getRepoRecommendation(text, repoList.map((r) => ({ path: r.path, name: r.name })))
    .then((rec) => {
      if (!rec) {
        patchDraftIf(token, { recommendingRepo: false });
        return;
      }
      const repo = repoList[rec.repoIndex];
      const current = get(draft);
      if (!current || current.createdAt !== token) return;
      patchDraftIf(token, {
        recommendingRepo: false,
        // Don't override a voice-set repo.
        repoId: current.repoId ?? repo?.id,
        repoRecommendation: {
          repoIndex: rec.repoIndex,
          repoName: repo?.name ?? `#${rec.repoIndex}`,
          reasoning: rec.reasoning,
          confidence: rec.confidence,
        },
      });
    })
    .catch(() => {
      patchDraftIf(token, { recommendingRepo: false });
    });

  const enabledModels = get(settings).enabled_models;
  void getModelRecommendation(text, enabledModels)
    .then((rec) => {
      const current = get(draft);
      if (!current || current.createdAt !== token) return;
      patchDraftIf(token, {
        recommendingModel: false,
        model: current.model ?? rec.model,
        effortLevel: current.effortLevel ?? (rec.effortLevel as EffortLevel | undefined) ?? undefined,
        modelRecommendation: rec.recommendation
          ? {
              modelId: rec.recommendation.modelId,
              reasoning: rec.recommendation.reasoning,
              effortLevel: (rec.recommendation.effortLevel as string | undefined) ?? undefined,
            }
          : undefined,
      });
    })
    .catch(() => {
      patchDraftIf(token, { recommendingModel: false });
    });
}

/** Map a spoken model family to a concrete enabled model id. */
function resolveModelFamily(family: 'opus' | 'sonnet' | 'haiku' | 'fable'): string | null {
  const enabled = get(settings).enabled_models;
  // Prefer an enabled model of that family, in catalog (newest-first) order.
  for (const model of ALL_MODELS) {
    if (model.id.includes(family) && enabled.includes(model.id)) return model.id;
  }
  // Fall back to the newest catalog model of the family even if not enabled.
  const catalogHit = ALL_MODELS.find((m) => m.id.includes(family));
  return catalogHit?.id ?? null;
}

/** Resolve a spoken repo name: exact normalized match, else UNIQUE substring. */
function resolveRepoByName(spoken: string): RepoConfig | null {
  const list = get(repos).list;
  const target = normalizeUtterance(spoken);
  const exact = list.filter((r) => normalizeUtterance(r.name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = list.filter((r) => {
    const name = normalizeUtterance(r.name);
    return name.includes(target) || target.includes(name);
  });
  return partial.length === 1 ? partial[0] : null;
}

async function launchDraft(d: CockpitDraft, heard: string, intentLabel: string): Promise<void> {
  const base = snapshotLaunchConfig();
  const repoList = get(repos).list;
  const repo =
    (d.repoId ? findRepoById(repoList, d.repoId) : null) ?? base?.repo ?? get(activeRepo);
  if (!repo) {
    recordFail(heard, intentLabel, 'no repository selected or configured');
    return;
  }
  const model = d.model ?? base?.model ?? get(settings).default_model;
  const effortLevel: EffortLevel = d.effortLevel ?? base?.effortLevel ?? 'low';
  const provider = getProviderForModel(model);

  const sessionId = await launchSession({
    prompt: d.transcript,
    repo,
    model,
    effortLevel,
    provider,
  });

  clearDraft();
  focusedSessionId.set(sessionId);
  recordOk(heard, intentLabel, `launched in ${repo.name} (${model})`);
}

// ---------------------------------------------------------------------------
// Fleet briefing
// ---------------------------------------------------------------------------

function computeBriefing(kind: FleetBriefing['kind'], ctx: CockpitContext): FleetBriefing {
  const all = get(sdkSessions);
  const boardIds = new Set(ctx.sessions.map((s) => s.id));
  const board = all.filter((s) => boardIds.has(s.id));

  const blocked: BriefingBlockedItem[] = [];
  const done: FleetBriefing['done'] = [];
  let running = 0;
  let errored = 0;

  for (const session of board) {
    const label = sessionLabel(session, ctx);
    if (session.pendingPlanApproval) {
      blocked.push({
        sessionId: session.id,
        label,
        reason: 'plan_approval',
        detail: session.pendingPlanApproval.plan?.slice(0, 200),
      });
    } else if (session.askUserQuestion) {
      blocked.push({
        sessionId: session.id,
        label,
        reason: 'question',
        detail: session.askUserQuestion.questions[session.askUserQuestion.currentQuestionIndex]?.question,
      });
    } else if (session.aiMetadata?.needsInteraction) {
      blocked.push({
        sessionId: session.id,
        label,
        reason: 'needs_interaction',
        detail: session.aiMetadata.interactionReason ?? session.aiMetadata.waitingFor,
      });
    }

    if (session.status === 'querying' || session.status === 'initializing') {
      running++;
    } else if (session.status === 'error') {
      errored++;
    }

    const ref = ctx.sessions.find((r) => r.id === session.id);
    if (ref?.isDone) {
      done.push({ sessionId: session.id, label, outcome: session.aiMetadata?.outcome });
    }
  }

  return {
    kind,
    generatedAt: Date.now(),
    counts: {
      running,
      blocked: blocked.length,
      done: done.length,
      error: errored,
      total: board.length,
    },
    blocked,
    done,
  };
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * Execute one parsed intent against app state.
 * `heard` is the raw utterance (for the ledger); defaults to the intent label.
 */
export async function executeIntent(
  intent: CockpitIntent,
  ctx: CockpitContext,
  heard?: string
): Promise<void> {
  const intentLabel = describeIntent(intent, ctx);
  const heardText = heard ?? intentLabel;

  try {
    switch (intent.type) {
      // --- focus ring ---
      case 'focus': {
        focusedSessionId.set(intent.sessionId);
        recordOk(heardText, intentLabel, `focused ${sessionLabel(findSession(intent.sessionId), ctx)}`);
        return;
      }

      // --- session verbs ---
      case 'continue_session': {
        const session = findSession(intent.sessionId);
        if (!session) return recordFail(heardText, intentLabel, 'session no longer exists');
        await sdkSessions.sendPrompt(intent.sessionId, 'keep going');
        recordOk(heardText, intentLabel, `nudged ${sessionLabel(session, ctx)}`);
        return;
      }

      case 'tell': {
        const session = findSession(intent.sessionId);
        if (!session) return recordFail(heardText, intentLabel, 'session no longer exists');
        await sdkSessions.sendPrompt(intent.sessionId, intent.text);
        recordOk(heardText, intentLabel, `sent to ${sessionLabel(session, ctx)}`);
        return;
      }

      case 'open_session': {
        const session = findSession(intent.sessionId);
        if (!session) return recordFail(heardText, intentLabel, 'session no longer exists');
        sdkSessions.selectSession(intent.sessionId);
        focusedSessionId.set(intent.sessionId);
        recordOk(heardText, intentLabel, `opened ${sessionLabel(session, ctx)}`);
        return;
      }

      // --- destructive: two-step confirm ---
      case 'stop_session':
      case 'reject':
      case 'dismiss_done': {
        armConfirm(intent, heardText, intentLabel);
        return;
      }

      case 'confirm_yes': {
        const pending = get(pendingConfirm);
        if (!pending) {
          return recordFail(heardText, intentLabel, 'nothing to confirm', 'rejected');
        }
        pendingConfirm.set(null);
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        if (Date.now() > pending.expiresAt) {
          updateLedger(pending.ledgerId, { status: 'cancelled', resultLabel: 'confirmation expired' });
          setInterpretation(heardText, pending.label, false);
          return;
        }
        try {
          const result = await performDestructive(pending.intent, ctx);
          updateLedger(pending.ledgerId, { status: 'ok', resultLabel: result });
          setInterpretation(heardText, pending.label, true);
        } catch (error) {
          updateLedger(pending.ledgerId, {
            status: 'error',
            resultLabel: error instanceof Error ? error.message : String(error),
          });
          setInterpretation(heardText, pending.label, false);
        }
        return;
      }

      case 'confirm_no': {
        const pending = get(pendingConfirm);
        if (!pending) {
          return recordFail(heardText, intentLabel, 'nothing to cancel', 'rejected');
        }
        pendingConfirm.set(null);
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        updateLedger(pending.ledgerId, { status: 'cancelled', resultLabel: 'cancelled by voice' });
        setInterpretation(heardText, pending.label, true);
        return;
      }

      // --- plan approval / questions ---
      case 'approve': {
        const session = findSession(intent.sessionId);
        if (!session) return recordFail(heardText, intentLabel, 'session no longer exists');
        if (session.pendingPlanApproval) {
          await sdkSessions.approvePlan(intent.sessionId);
          recordOk(heardText, intentLabel, `plan approved for ${sessionLabel(session, ctx)}`);
          return;
        }
        if (session.askUserQuestion) {
          if (allQuestionsAnswered(session)) {
            await sdkSessions.submitAskUserAnswers(intent.sessionId);
            recordOk(heardText, intentLabel, `answers submitted to ${sessionLabel(session, ctx)}`);
          } else {
            recordFail(
              heardText,
              intentLabel,
              'open question — answer with an option number first',
              'rejected'
            );
          }
          return;
        }
        recordFail(heardText, intentLabel, 'nothing awaiting approval', 'rejected');
        return;
      }

      case 'answer_option': {
        const session = findSession(intent.sessionId);
        if (!session?.askUserQuestion) {
          return recordFail(heardText, intentLabel, 'no open question', 'rejected');
        }
        const qIndex = firstUnansweredIndex(session);
        if (qIndex === -1) {
          return recordFail(heardText, intentLabel, 'all questions already answered', 'rejected');
        }
        const question = session.askUserQuestion.questions[qIndex];
        const optIdx = intent.option - 1; // spoken 1-based → 0-based
        const option = question.options[optIdx];
        if (!option) {
          return recordFail(
            heardText,
            intentLabel,
            `option ${intent.option} doesn't exist (${question.options.length} options)`,
            'rejected'
          );
        }
        const answer: PlanningAnswer = { questionIndex: qIndex, selectedOptions: [optIdx] };
        sdkSessions.updateAskUserAnswer(intent.sessionId, answer);

        const updated = findSession(intent.sessionId);
        if (updated && allQuestionsAnswered(updated)) {
          await sdkSessions.submitAskUserAnswers(intent.sessionId);
          recordOk(heardText, intentLabel, `answered "${option.label}" — submitted`);
        } else {
          sdkSessions.setAskUserQuestionIndex(intent.sessionId, qIndex + 1);
          recordOk(heardText, intentLabel, `answered "${option.label}" — next question`);
        }
        return;
      }

      case 'answer_text': {
        const session = findSession(intent.sessionId);
        if (!session?.askUserQuestion) {
          return recordFail(heardText, intentLabel, 'no open question', 'rejected');
        }
        const qIndex = firstUnansweredIndex(session);
        if (qIndex === -1) {
          return recordFail(heardText, intentLabel, 'all questions already answered', 'rejected');
        }
        const answer: PlanningAnswer = {
          questionIndex: qIndex,
          selectedOptions: [],
          textInput: intent.text,
        };
        sdkSessions.updateAskUserAnswer(intent.sessionId, answer);

        const updated = findSession(intent.sessionId);
        if (updated && allQuestionsAnswered(updated)) {
          await sdkSessions.submitAskUserAnswers(intent.sessionId);
          recordOk(heardText, intentLabel, 'answer submitted');
        } else {
          sdkSessions.setAskUserQuestionIndex(intent.sessionId, qIndex + 1);
          recordOk(heardText, intentLabel, 'answer staged — next question');
        }
        return;
      }

      // --- dispatch draft flow ---
      case 'dispatch': {
        const newDraft = createDraftFromText(intent.text);
        setDraft(newDraft);
        enrichDraft(newDraft);
        recordOk(heardText, intentLabel, 'draft opened — say "go" to launch');
        return;
      }

      case 'draft_go': {
        const current = get(draft);
        if (!current) return recordFail(heardText, intentLabel, 'no draft open', 'rejected');
        await launchDraft(current, heardText, intentLabel);
        return;
      }

      case 'draft_cancel': {
        if (!get(draft)) return recordFail(heardText, intentLabel, 'no draft open', 'rejected');
        clearDraft();
        recordOk(heardText, intentLabel, 'draft discarded');
        return;
      }

      case 'draft_set_model': {
        const current = get(draft);
        if (!current) return recordFail(heardText, intentLabel, 'no draft open', 'rejected');
        const modelId = resolveModelFamily(intent.model);
        if (!modelId) return recordFail(heardText, intentLabel, `no ${intent.model} model available`, 'rejected');
        patchDraftIf(current.createdAt, { model: modelId });
        recordOk(heardText, intentLabel, `model set to ${modelId}`);
        return;
      }

      case 'draft_set_repo': {
        const current = get(draft);
        if (!current) return recordFail(heardText, intentLabel, 'no draft open', 'rejected');
        const repo = resolveRepoByName(intent.name);
        if (!repo) {
          return recordFail(heardText, intentLabel, `no unique repo matching "${intent.name}"`, 'rejected');
        }
        patchDraftIf(current.createdAt, { repoId: repo.id });
        recordOk(heardText, intentLabel, `repo set to ${repo.name}`);
        return;
      }

      case 'draft_append': {
        const current = get(draft);
        if (!current) return recordFail(heardText, intentLabel, 'no draft open', 'rejected');
        patchDraftIf(current.createdAt, {
          transcript: `${current.transcript} ${intent.text}`.trim(),
          rawTranscript: `${current.rawTranscript} ${intent.text}`.trim(),
        });
        recordOk(heardText, intentLabel, 'appended to draft');
        return;
      }

      // --- pile ---
      case 'pile_note': {
        pile.addRecording({ transcript: intent.text });
        recordOk(heardText, intentLabel, 'parked in pile');
        return;
      }

      // --- fleet briefings ---
      case 'status': {
        const briefing = computeBriefing('status', ctx);
        fleetBriefing.set(briefing);
        const c = briefing.counts;
        recordOk(
          heardText,
          intentLabel,
          `${c.running} running · ${c.blocked} blocked · ${c.done} done · ${c.error} error`
        );
        return;
      }

      case 'what_needs_me': {
        const briefing = computeBriefing('what_needs_me', ctx);
        fleetBriefing.set(briefing);
        recordOk(
          heardText,
          intentLabel,
          briefing.blocked.length === 0
            ? 'nothing needs you'
            : `${briefing.blocked.length} blocked: ${briefing.blocked.map((b) => b.label).join(', ')}`
        );
        return;
      }

      // --- visible failure ---
      case 'ambiguous': {
        // Duplicate nickname: never pick silently — the label already lists
        // the matching board numbers so the user can re-address by number.
        recordFail(heardText, intentLabel, 'ambiguous nickname — say the board number', 'rejected');
        return;
      }
      case 'unknown': {
        recordFail(heardText, intentLabel, 'not recognized — nothing executed', 'rejected');
        return;
      }
    }
  } catch (error) {
    console.error('[cockpit] Intent execution failed:', intent.type, error);
    recordFail(
      heardText,
      intentLabel,
      error instanceof Error ? error.message : 'execution failed'
    );
  }
}

/** Clear any armed confirmation timer (used on cockpit deactivate). */
export function cancelPendingConfirm(): void {
  const pending = get(pendingConfirm);
  if (pending) {
    updateLedger(pending.ledgerId, { status: 'cancelled', resultLabel: 'cockpit closed' });
    pendingConfirm.set(null);
  }
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
}
