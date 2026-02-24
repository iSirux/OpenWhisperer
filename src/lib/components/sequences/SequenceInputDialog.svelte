<script lang="ts">
  import type { SequenceDefinition } from '$lib/types/sequence';
  import { startExecution } from '$lib/stores/sequenceExecutions';
  import { settings } from '$lib/stores/settings';
  import { repos } from '$lib/stores/repos';
  import RepoIcon from '$lib/components/RepoIcon.svelte';

  interface Props {
    sequence: SequenceDefinition;
    onclose: () => void;
  }
  let { sequence, onclose }: Props = $props();

  let values: Record<string, unknown> = $state({});
  let errors: Record<string, string> = $state({});
  let loading = $state(false);

  // Initialize defaults
  $effect(() => {
    const defaults: Record<string, unknown> = {};
    for (const input of sequence.inputs) {
      if (input.default !== undefined) {
        defaults[input.name] = input.default;
      } else {
        defaults[input.name] = input.type === 'boolean' ? false : input.type === 'number' ? 0 : '';
      }
    }
    values = defaults;
  });

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    for (const input of sequence.inputs) {
      const value = values[input.name];
      if (input.required && (value === undefined || value === '' || value === null)) {
        newErrors[input.name] = 'Required';
        continue;
      }
      if (input.validation) {
        const v = input.validation;
        const strVal = String(value ?? '');
        if (v.min_length && strVal.length < v.min_length) {
          newErrors[input.name] = `Min ${v.min_length} characters`;
        }
        if (v.max_length && strVal.length > v.max_length) {
          newErrors[input.name] = `Max ${v.max_length} characters`;
        }
        if (v.pattern) {
          try {
            if (!new RegExp(v.pattern).test(strVal)) {
              newErrors[input.name] = `Must match pattern: ${v.pattern}`;
            }
          } catch { /* invalid regex */ }
        }
      }
    }
    errors = newErrors;
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;
    loading = true;
    try {
      await startExecution(sequence.id, values as Record<string, unknown>);
      onclose();
    } catch (error) {
      console.error('Failed to start execution:', error);
    } finally {
      loading = false;
    }
  }
</script>

<!-- Modal backdrop -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onclick={onclose}
  role="dialog" aria-modal="true" aria-label="Run sequence">
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="bg-surface border border-border rounded-lg shadow-xl w-full max-w-md mx-4"
    onclick={(e) => e.stopPropagation()}>

    <header class="flex items-center justify-between px-4 py-3 border-b border-border">
      <h3 class="text-sm font-semibold text-text-primary">Run: {sequence.name}</h3>
      <button class="text-text-muted hover:text-text-primary" onclick={onclose}>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </header>

    <div class="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
      {#if sequence.description}
        <p class="text-xs text-text-muted">{sequence.description}</p>
      {/if}

      {#if sequence.inputs.length === 0}
        <p class="text-sm text-text-secondary">This sequence has no inputs. Click Run to start.</p>
      {:else}
        {#each sequence.inputs as input (input.name)}
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1">
              {input.name}
              {#if input.required}<span class="text-red-400">*</span>{/if}
            </label>
            {#if input.description}
              <p class="text-[10px] text-text-muted mb-1">{input.description}</p>
            {/if}

            {#if input.type === 'boolean'}
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={!!values[input.name]}
                  onchange={(e) => values[input.name] = e.currentTarget.checked}
                  class="rounded border-border accent-accent" />
                <span class="text-xs text-text-secondary">Enabled</span>
              </label>
            {:else if input.type === 'number'}
              <input type="number" value={Number(values[input.name] ?? 0)}
                oninput={(e) => values[input.name] = Number(e.currentTarget.value)}
                class="w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
            {:else if input.validation?.enum}
              <select value={String(values[input.name] ?? '')}
                onchange={(e) => values[input.name] = e.currentTarget.value}
                class="w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
                {#each input.validation.enum as opt}
                  <option value={opt}>{opt}</option>
                {/each}
              </select>
            {:else if input.type === 'repo_list'}
              <!-- Multi-select repo picker with tag filter -->
              {@const selectedRepos = Array.isArray(values[input.name]) ? values[input.name] as string[] : []}
              {@const allTags = [...new Set($repos.list.flatMap(r => r.tags || []))]}
              <div class="space-y-1.5">
                {#if allTags.length > 0}
                  <div class="flex flex-wrap gap-1 mb-1">
                    <span class="text-[10px] text-text-muted">Filter by tag:</span>
                    {#each allTags as tag}
                      <button
                        class="px-1.5 py-0.5 text-[10px] rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                        onclick={() => {
                          const taggedPaths = $repos.list.filter(r => (r.tags || []).includes(tag)).map(r => r.path);
                          const current = new Set(selectedRepos);
                          taggedPaths.forEach(p => current.add(p));
                          values[input.name] = [...current];
                        }}
                      >{tag}</button>
                    {/each}
                  </div>
                {/if}
                {#each $repos.list as repo}
                  <label class="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-surface-elevated/50">
                    <input type="checkbox"
                      checked={selectedRepos.includes(repo.path)}
                      onchange={(e) => {
                        const isChecked = e.currentTarget.checked;
                        const current = [...selectedRepos];
                        if (isChecked) {
                          current.push(repo.path);
                        } else {
                          const idx = current.indexOf(repo.path);
                          if (idx >= 0) current.splice(idx, 1);
                        }
                        values[input.name] = current;
                      }}
                      class="rounded border-border accent-accent" />
                    <RepoIcon repo={repo} size="xs" />
                    <div class="flex-1 min-w-0">
                      <span class="text-xs text-text-primary">{repo.name}</span>
                      {#if (repo.tags || []).length > 0}
                        <span class="ml-1.5 text-[9px] text-text-muted">{(repo.tags || []).join(', ')}</span>
                      {/if}
                    </div>
                  </label>
                {/each}
              </div>
            {:else}
              <input type="text" value={String(values[input.name] ?? '')}
                oninput={(e) => values[input.name] = e.currentTarget.value}
                class="w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
                placeholder={input.description ?? ''} />
            {/if}

            {#if errors[input.name]}
              <p class="text-[10px] text-red-400 mt-0.5">{errors[input.name]}</p>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <footer class="flex justify-end gap-2 px-4 py-3 border-t border-border">
      <button class="px-3 py-1.5 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors"
        onclick={onclose}>
        Cancel
      </button>
      <button class="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
        disabled={loading}
        onclick={handleSubmit}>
        {loading ? 'Starting...' : 'Run'}
      </button>
    </footer>
  </div>
</div>
