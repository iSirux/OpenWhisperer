/**
 * Agent account helpers — resolving which "agent account" (isolated provider
 * login profile) a session should use.
 *
 * The machine's default login of each provider is a stored account like any
 * other (id `default-claude` / `default-openai`, no `config_dir`) so it carries a
 * user label and color. Sessions still carry `undefined` for the machine default
 * so pre-feature behavior/persistence is unchanged — resolve that with
 * `sessionAccount`.
 */

import type { AgentAccount, SdkProvider } from '$lib/stores/settings';
import type { RepoConfig } from '$lib/stores/repos';

/** Reserved account IDs for the machine-default login of each provider. */
export const DEFAULT_ACCOUNT_ID: Record<SdkProvider, string> = {
  Claude: 'default-claude',
  OpenAI: 'default-openai',
};

/** Neutral gray the default accounts are seeded with (mirrors the backend). */
const DEFAULT_ACCOUNT_COLOR = '#6b7280';

/** Whether an account id is one of the reserved machine-login ids (no env override). */
export function isDefaultAccountId(id: string | null | undefined): boolean {
  return id === DEFAULT_ACCOUNT_ID.Claude || id === DEFAULT_ACCOUNT_ID.OpenAI;
}

/**
 * The machine-login account for a provider: the stored entry (with the user's
 * label/color) when present, else a built-in fallback — the backend always
 * stores both, so the fallback only covers settings that haven't loaded yet.
 */
export function defaultAccountFor(
  provider: SdkProvider,
  accounts?: AgentAccount[] | null,
): AgentAccount {
  const id = DEFAULT_ACCOUNT_ID[provider];
  return (
    (accounts ?? []).find((a) => a.id === id) ?? {
      id,
      label: 'Default',
      color: DEFAULT_ACCOUNT_COLOR,
      provider,
      config_dir: null,
    }
  );
}

/**
 * All selectable accounts for a provider: the machine-login account first,
 * followed by the other non-disabled accounts of that provider. A disabled
 * default is left out unless nothing else is left.
 */
export function accountsForProvider(
  accounts: AgentAccount[] | null | undefined,
  provider: SdkProvider,
): AgentAccount[] {
  const fallback = defaultAccountFor(provider, accounts);
  const rest = (accounts ?? []).filter(
    (a) => a.provider === provider && !a.disabled && !isDefaultAccountId(a.id),
  );
  const list = fallback.disabled ? rest : [fallback, ...rest];
  return list.length > 0 ? list : [fallback];
}

/**
 * Accounts allowed for a repo + provider. Starts from `accountsForProvider`; if the
 * repo has a non-empty `account_ids` whitelist, keeps only listed accounts (the
 * default id counts like any other). If the filter leaves zero accounts, falls
 * back to just the machine-login account.
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
  return filtered.length > 0 ? filtered : [defaultAccountFor(provider, accounts)];
}

/**
 * The id of the FIRST allowed account for a repo+provider (whitelist order =
 * preference order). Returns `undefined` when that is the machine-login account,
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

/** Resolve an account id to its account (machine-login accounts included). */
export function accountById(
  accounts: AgentAccount[] | null | undefined,
  id: string | null | undefined,
): AgentAccount | undefined {
  if (!id) return undefined;
  if (id === DEFAULT_ACCOUNT_ID.Claude) return defaultAccountFor('Claude', accounts);
  if (id === DEFAULT_ACCOUNT_ID.OpenAI) return defaultAccountFor('OpenAI', accounts);
  return (accounts ?? []).find((a) => a.id === id);
}

/**
 * The account a session runs under, for display: its pinned account, or the
 * machine-login account of its provider when it carries none. `provider` takes
 * the lowercase session casing (`'claude' | 'openai'`).
 */
export function sessionAccount(
  accounts: AgentAccount[] | null | undefined,
  accountId: string | null | undefined,
  provider: 'claude' | 'openai' | null | undefined,
): AgentAccount | undefined {
  if (accountId) return accountById(accounts, accountId);
  return defaultAccountFor(provider === 'openai' ? 'OpenAI' : 'Claude', accounts);
}
