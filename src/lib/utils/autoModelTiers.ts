/**
 * Auto-model tier ladder.
 *
 * The LLM recommender no longer picks a model: it grades each prompt with a
 * complexity score (1-10, anchored rubric in `src-tauri/src/llm/features.rs`).
 * This module maps that score to a concrete model + effort through the
 * user-configured breakpoint ladder (`settings.llm.features.auto_model_tiers`),
 * or — when none is configured — a ladder derived from `enabled_models` and
 * `auto_model_effort` that roughly reproduces the old Haiku/Sonnet/Opus picks.
 *
 * Rule: the highest tier whose `min_score` <= score wins. The first tier is
 * always forced to `min_score: 0`, so every score resolves.
 */

import type { AppConfig, AutoModelEffort } from '$lib/stores/settings';
import {
  ALL_MODELS,
  DEFAULT_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID,
  OPENAI_MODELS,
  clampEffortForModel,
  getModelById,
  getProviderForModel,
  isAutoModel,
  modelSupportsEffort,
  modelSupportsXhigh,
  normalizeOpenAiModelId,
  type SdkProvider,
} from '$lib/utils/models';

export type TierEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Effort of a tier: a level, or `null` = no effort parameter. */
export type EffortLevel = TierEffort | null;

export interface AutoModelTier {
  min_score: number;
  model: string;
  effort: EffortLevel | null;
}

export interface ResolvedTier {
  model: string;
  effort: EffortLevel | null;
  tier: AutoModelTier;
}

export interface TierOptions {
  /**
   * Keep the pick on one provider — used when the session already exists on a
   * provider (its sidecar session can switch model but not provider). See
   * `resolveTier` for how a mixed ladder maps onto one provider.
   */
  provider?: SdkProvider;
}

type TierSettings = Pick<AppConfig, 'llm' | 'enabled_models'> &
  Partial<Pick<AppConfig, 'enabled_providers'>>;

const TIER_EFFORTS: readonly TierEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Clamp any score-ish value into 1..10 (NaN → 5). */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 5;
  return Math.min(10, Math.max(1, Math.round(score)));
}

function normalizeTierEffort(effort: unknown): EffortLevel {
  if (typeof effort !== 'string') return null;
  const e = effort.toLowerCase();
  return (TIER_EFFORTS as readonly string[]).includes(e) ? (e as TierEffort) : null;
}

function providerEnabled(settings: TierSettings, provider: SdkProvider): boolean {
  const enabled = settings.enabled_providers;
  if (!enabled) return true;
  return provider === 'openai' ? enabled.openai !== false : enabled.claude !== false;
}

/** Clamp a tier's effort to what its model supports (null for no-effort models). */
function fitEffort(model: string, effort: EffortLevel): EffortLevel {
  if (effort == null) return null;
  if (!modelSupportsEffort(model)) return null;
  let e = clampEffortForModel(effort, model) as TierEffort;
  if (e === 'xhigh' && getProviderForModel(model) === 'claude' && !modelSupportsXhigh(model)) {
    e = 'high';
  }
  return e;
}

/** Sort, force the first rung to 0, fit efforts, drop exact duplicates. */
function finalizeLadder(tiers: AutoModelTier[]): AutoModelTier[] {
  const sorted = [...tiers]
    .map((t) => ({
      min_score: Math.min(10, Math.max(0, Math.round(Number(t.min_score) || 0))),
      model: normalizeOpenAiModelId(t.model),
      effort: fitEffort(normalizeOpenAiModelId(t.model), normalizeTierEffort(t.effort)),
    }))
    .sort((a, b) => a.min_score - b.min_score);
  if (sorted.length === 0) return sorted;
  sorted[0] = { ...sorted[0], min_score: 0 };
  const out: AutoModelTier[] = [];
  for (const t of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.model === t.model && prev.effort === t.effort) continue; // no-op rung
    if (prev && prev.min_score === t.min_score) {
      out[out.length - 1] = t; // later entry at the same threshold wins
      continue;
    }
    out.push(t);
  }
  return out;
}

/** First enabled model id among `candidates` (in preference order). */
function pick(enabled: Set<string>, candidates: string[]): string | undefined {
  return candidates.find((id) => enabled.has(id));
}

/**
 * Derived default ladder for one provider from `enabled_models` +
 * `auto_model_effort`. `Dynamic` grades effort with the score; a fixed
 * `auto_model_effort` applies that effort to every rung (`off` → none).
 */
function derivedTiersForProvider(
  settings: TierSettings,
  provider: SdkProvider,
): AutoModelTier[] {
  const enabled = new Set((settings.enabled_models ?? []).map(normalizeOpenAiModelId));
  const effortSetting: AutoModelEffort =
    settings.llm?.features?.auto_model_effort ??
    settings.llm?.features?.auto_model_thinking ??
    'dynamic';

  let cheap: string | undefined;
  let mid: string | undefined;
  let top: string | undefined;
  if (provider === 'claude') {
    const opus = ALL_MODELS.filter((m) => m.id.startsWith('claude-opus')).map((m) => m.id);
    const sonnet = ALL_MODELS.filter((m) => m.id.startsWith('claude-sonnet')).map((m) => m.id);
    const haiku = ALL_MODELS.filter((m) => m.id.startsWith('claude-haiku')).map((m) => m.id);
    cheap = pick(enabled, haiku);
    mid = pick(enabled, sonnet);
    top = pick(enabled, opus);
    // Fable etc. only when nothing from the classic trio is enabled.
    if (!cheap && !mid && !top) {
      top = pick(enabled, ALL_MODELS.map((m) => m.id));
    }
  } else {
    const ids = OPENAI_MODELS.map((m) => m.id);
    // Newest version of each tier name first, so new releases slot in unlisted.
    const tier = (name: string) =>
      ids
        .map((id) => ({ id, v: new RegExp(`^gpt-([\d.]+)-${name}$`).exec(id)?.[1] }))
        .filter((x): x is { id: string; v: string } => !!x.v)
        .sort((a, b) => parseFloat(b.v) - parseFloat(a.v))
        .map((x) => x.id);
    cheap = pick(enabled, [...tier('luna'), ...tier('mini')]);
    mid = pick(enabled, [...tier('terra'), ...tier('sol')]);
    top = pick(enabled, [...tier('astra'), ...tier('sol')]);
    if (!cheap && !mid && !top) {
      top = pick(enabled, ids);
    }
  }

  // Fill gaps: each role falls back to the nearest available model.
  const midModel = mid ?? top ?? cheap;
  const topModel = top ?? mid ?? cheap;
  const cheapModel = cheap ?? mid ?? top;
  if (!cheapModel || !midModel || !topModel) return [];

  const fixed: EffortLevel | undefined =
    effortSetting === 'dynamic'
      ? undefined
      : effortSetting === 'off'
        ? null
        : (normalizeTierEffort(effortSetting) ?? null);
  const e = (graded: EffortLevel): EffortLevel => (fixed === undefined ? graded : fixed);

  return finalizeLadder([
    { min_score: 0, model: cheapModel, effort: e(null) },
    { min_score: 3, model: midModel, effort: e('low') },
    { min_score: 5, model: midModel, effort: e('medium') },
    { min_score: 7, model: topModel, effort: e('high') },
    { min_score: 9, model: topModel, effort: e('xhigh') },
  ]);
}

/**
 * Configured tiers that can actually run: a known (non-Auto) model that is in
 * `enabled_models` and whose provider is enabled. Dropping a rung makes its
 * score band fall through to the next lower valid rung (the ladder is
 * "highest `min_score <= score` wins"), or — for the bottom rung — lets the
 * next valid rung take over `min_score: 0` in `finalizeLadder`.
 */
function usableConfiguredTiers(settings: TierSettings, provider?: SdkProvider): AutoModelTier[] {
  const enabled = settings.enabled_models
    ? new Set(settings.enabled_models.map(normalizeOpenAiModelId))
    : null;
  return (settings.llm?.features?.auto_model_tiers ?? []).filter((t) => {
    if (!t || typeof t.model !== 'string' || t.model.trim() === '') return false;
    const model = normalizeOpenAiModelId(t.model);
    const info = getModelById(model);
    if (!info || isAutoModel(model)) return false; // unknown / stale id
    if (enabled && !enabled.has(model)) return false;
    const p = getProviderForModel(model);
    if (!providerEnabled(settings, p)) return false;
    return !provider || p === provider;
  }) as AutoModelTier[];
}

/**
 * The ladder in effect: the valid configured tiers (see
 * `usableConfiguredTiers`), or the derived defaults. First tier forced to
 * `min_score: 0`. Never empty — falls back to a single default-model tier.
 */
export function effectiveTiers(settings: TierSettings, opts: TierOptions = {}): AutoModelTier[] {
  const usable = usableConfiguredTiers(settings, opts.provider);
  if (usable.length > 0) return finalizeLadder(usable);

  const providers: SdkProvider[] = opts.provider
    ? [opts.provider]
    : (['claude', 'openai'] as SdkProvider[]).filter((p) => providerEnabled(settings, p));
  for (const provider of providers) {
    const derived = derivedTiersForProvider(settings, provider);
    if (derived.length > 0) return derived;
  }

  const fallbackModel = opts.provider === 'openai' ? DEFAULT_OPENAI_MODEL_ID : DEFAULT_MODEL_ID;
  return [{ min_score: 0, model: fallbackModel, effort: fitEffort(fallbackModel, 'medium') }];
}

/** Highest tier with `min_score <= score` (tiers sorted ascending, non-empty). */
function pickTier(tiers: AutoModelTier[], score: number): AutoModelTier {
  let tier = tiers[0];
  for (const t of tiers) {
    if (t.min_score <= score) tier = t;
  }
  return tier;
}

/**
 * Map a complexity score to its tier: the highest tier with `min_score <= score`.
 *
 * Provider-restricted resolution (`opts.provider`, existing sessions) — rule:
 * 1. Resolve the score on the FULL (mixed-provider) ladder → rung R.
 * 2. R already on the session's provider → R.
 * 3. Otherwise build that provider's ladder from its own configured rungs.
 *    If none of them sits at or above R's level (`min_score >= R.min_score`),
 *    the configured ladder says nothing about this provider at this
 *    complexity, so the provider's derived rungs from R's level upward are
 *    added (derived defaults, same as an unconfigured ladder). Resolve the
 *    score on that ladder.
 *    Consequence: a high score never lands on a cheap same-provider rung
 *    merely because the expensive rungs belong to the other provider (e.g.
 *    "Haiku 0-4, GPT 5+" at score 9 on a Claude session → Opus, not Haiku);
 *    when the provider does have configured rungs around R, the highest one
 *    with `min_score <= score` wins, exactly like the plain ladder.
 * 4. No configured rung for the provider at all → its derived ladder.
 */
export function resolveTier(score: number, settings: TierSettings, opts: TierOptions = {}): ResolvedTier {
  const s = clampScore(score);
  const done = (tier: AutoModelTier): ResolvedTier => ({ model: tier.model, effort: tier.effort, tier });

  if (!opts.provider) return done(pickTier(effectiveTiers(settings), s));

  const provider = opts.provider;
  const full = effectiveTiers(settings);
  const resolved = pickTier(full, s);
  if (getProviderForModel(resolved.model) === provider) return done(resolved);

  const own = finalizeLadder(usableConfiguredTiers(settings, provider));
  if (own.length === 0) return done(pickTier(effectiveTiers(settings, { provider }), s));

  const coversLevel = own.some((t) => t.min_score >= resolved.min_score);
  if (coversLevel) return done(pickTier(own, s));

  const derivedAbove = derivedTiersForProvider(settings, provider).filter(
    (t) => t.min_score >= resolved.min_score,
  );
  if (derivedAbove.length === 0) return done(pickTier(own, s));
  // Merge without finalizeLadder's dedupe collapsing ordering: own rungs stay
  // below R's level, derived rungs start at it.
  const merged = [...own.filter((t) => t.min_score < resolved.min_score), ...derivedAbove].sort(
    (a, b) => a.min_score - b.min_score,
  );
  return done(pickTier(merged, s));
}

/** Short model label for hints ("Opus 5.5"), falling back to the id. */
export function tierModelLabel(model: string): string {
  return getModelById(model)?.label ?? model;
}

/** Compact "Auto · 7 → Opus 5.5 high" hint. */
export function describeAutoPick(score: number, model: string, effort: EffortLevel | undefined): string {
  return `Auto · ${clampScore(score)} → ${tierModelLabel(model)}${effort ? ` ${effort}` : ''}`;
}
