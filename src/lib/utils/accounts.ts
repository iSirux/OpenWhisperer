/**
 * Agent account helpers — resolving which "agent account" (isolated provider
 * login profile) a session should use.
 *
 * The machine's existing default provider login is represented as a synthesized
 * *virtual* account (id `default-claude` / `default-openai`) that is never stored
 * in config. Sessions carry `undefined` for the machine default so pre-feature
 * behavior/persistence is unchanged.
 */

import type { AgentAccount, SdkProvider } from '$lib/stores/settings';
import type { RepoConfig } from '$lib/stores/repos';

/** Reserved virtual account IDs for the machine-default login of each provider. */
export const DEFAULT_ACCOUNT_ID: Record<SdkProvider, string> = {
  Claude: 'default-claude',
  OpenAI: 'default-openai',
};

/** Neutral gray used for the synthesized default account swatch. */
const DEFAULT_ACCOUNT_COLOR = '#6b7280';

/** Whether an account id is one of the reserved virtual-default ids. */
export function isDefaultAccountId(id: string | null | undefined): boolean {
  return id === DEFAULT_ACCOUNT_ID.Claude || id === DEFAULT_ACCOUNT_ID.OpenAI;
}

/** Synthesize the virtual "Default" account for a provider (machine-default login). */
export function defaultAccountFor(provider: SdkProvider): AgentAccount {
  return {
    id: DEFAULT_ACCOUNT_ID[provider],
    label: 'Default',
    color: DEFAULT_ACCOUNT_COLOR,
    provider,
    config_dir: null,
  };
}

/**
 * All selectable accounts for a provider: the virtual default first, followed by
 * configured, non-disabled accounts of that provider.
 */
export function accountsForProvider(
  accounts: AgentAccount[] | null | undefined,
  provider: SdkProvider,
): AgentAccount[] {
  const configured = (accounts ?? []).filter((a) => a.provider === provider && !a.disabled);
  return [defaultAccountFor(provider), ...configured];
}

/**
 * Accounts allowed for a repo + provider. Starts from `accountsForProvider`; if the
 * repo has a non-empty `account_ids` whitelist, keeps only listed accounts (the
 * virtual default id counts like any other). If the filter leaves zero accounts,
 * falls back to just the virtual default.
 */
export function allowedAccountsForRepo(
  accounts: AgentAccount[] | null | undefined,
  repo: RepoConfig | null | undefined,
  provider: SdkProvider,
): AgentAccount[] {
  const all = accountsForProvider(accounts, provider);
  const whitelist = repo?.account_ids;
  if (!whitelist || whitelist.length === 0) return all;
  const filtered = all.filter((a) => whitelist.includes(a.id));
  return filtered.length > 0 ? filtered : [defaultAccountFor(provider)];
}

/**
 * The id of the FIRST allowed account for a repo+provider (whitelist order =
 * preference order). Returns `undefined` when that is the virtual default account,
 * so sessions carry `undefined` for the machine default.
 */
export function defaultAccountIdForRepo(
  accounts: AgentAccount[] | null | undefined,
  repo: RepoConfig | null | undefined,
  provider: SdkProvider,
): string | undefined {
  const first = allowedAccountsForRepo(accounts, repo, provider)[0];
  if (!first || isDefaultAccountId(first.id)) return undefined;
  return first.id;
}

/** Resolve an account id to its account — configured accounts AND the two virtual defaults. */
export function accountById(
  accounts: AgentAccount[] | null | undefined,
  id: string | null | undefined,
): AgentAccount | undefined {
  if (!id) return undefined;
  if (id === DEFAULT_ACCOUNT_ID.Claude) return defaultAccountFor('Claude');
  if (id === DEFAULT_ACCOUNT_ID.OpenAI) return defaultAccountFor('OpenAI');
  return (accounts ?? []).find((a) => a.id === id);
}
