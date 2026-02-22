<script lang="ts">
  import { settings } from '$lib/stores/settings';
  import { invoke } from '@tauri-apps/api/core';
  import { listEventTriggers } from '$lib/stores/sequences';
  import type { NotificationChannelType, NotificationChannelConfig } from '$lib/stores/settings';
  import type { EventTriggerInfo } from '$lib/types/sequence';

  let eventTriggers = $state<EventTriggerInfo[]>([]);

  async function loadEventTriggers() {
    eventTriggers = await listEventTriggers();
  }
  // Load on mount
  $effect(() => { loadEventTriggers(); });

  let showAddForm = $state(false);
  let editingChannelId = $state<string | null>(null);
  let testingChannelId = $state<string | null>(null);
  let testResult = $state<{ channelId: string; success: boolean; message: string } | null>(null);

  // New channel form state
  let newName = $state('');
  let newType = $state<NotificationChannelType>('slack');
  let newWebhookUrl = $state('');
  let newEnabled = $state(true);
  let newHeaderKey = $state('');
  let newHeaderValue = $state('');
  let newHeaders = $state<Record<string, string>>({});

  // Edit form state
  let editName = $state('');
  let editType = $state<NotificationChannelType>('slack');
  let editWebhookUrl = $state('');
  let editEnabled = $state(true);
  let editHeaderKey = $state('');
  let editHeaderValue = $state('');
  let editHeaders = $state<Record<string, string>>({});

  function slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function resetNewForm() {
    newName = '';
    newType = 'slack';
    newWebhookUrl = '';
    newEnabled = true;
    newHeaderKey = '';
    newHeaderValue = '';
    newHeaders = {};
    showAddForm = false;
  }

  function addChannel() {
    if (!newName.trim()) return;
    const id = slugify(newName);
    if (!id) return;

    // Prevent duplicate IDs
    if ($settings.sequences.notification_channels.some(c => c.id === id)) return;

    const channel: NotificationChannelConfig = {
      id,
      name: newName.trim(),
      channel_type: newType,
      webhook_url: newWebhookUrl || null,
      headers: newType === 'webhook' && Object.keys(newHeaders).length > 0 ? { ...newHeaders } : null,
      enabled: newEnabled,
    };

    $settings.sequences.notification_channels = [
      ...$settings.sequences.notification_channels,
      channel,
    ];
    resetNewForm();
  }

  function addNewHeader() {
    if (!newHeaderKey.trim()) return;
    newHeaders = { ...newHeaders, [newHeaderKey.trim()]: newHeaderValue };
    newHeaderKey = '';
    newHeaderValue = '';
  }

  function removeNewHeader(key: string) {
    const copy = { ...newHeaders };
    delete copy[key];
    newHeaders = copy;
  }

  function startEditing(channel: NotificationChannelConfig) {
    editingChannelId = channel.id;
    editName = channel.name;
    editType = channel.channel_type;
    editWebhookUrl = channel.webhook_url || '';
    editEnabled = channel.enabled;
    editHeaders = channel.headers ? { ...channel.headers } : {};
    editHeaderKey = '';
    editHeaderValue = '';
  }

  function cancelEditing() {
    editingChannelId = null;
  }

  function saveEditing(index: number) {
    if (!editName.trim() || editingChannelId === null) return;

    const updated: NotificationChannelConfig = {
      id: editingChannelId,
      name: editName.trim(),
      channel_type: editType,
      webhook_url: editWebhookUrl || null,
      headers: editType === 'webhook' && Object.keys(editHeaders).length > 0 ? { ...editHeaders } : null,
      enabled: editEnabled,
    };

    const channels = [...$settings.sequences.notification_channels];
    channels[index] = updated;
    $settings.sequences.notification_channels = channels;
    editingChannelId = null;
  }

  function addEditHeader() {
    if (!editHeaderKey.trim()) return;
    editHeaders = { ...editHeaders, [editHeaderKey.trim()]: editHeaderValue };
    editHeaderKey = '';
    editHeaderValue = '';
  }

  function removeEditHeader(key: string) {
    const copy = { ...editHeaders };
    delete copy[key];
    editHeaders = copy;
  }

  function removeChannel(index: number) {
    $settings.sequences.notification_channels = $settings.sequences.notification_channels.filter(
      (_, idx) => idx !== index
    );
  }

  function toggleChannelEnabled(index: number) {
    const channels = [...$settings.sequences.notification_channels];
    channels[index] = { ...channels[index], enabled: !channels[index].enabled };
    $settings.sequences.notification_channels = channels;
  }

  async function testChannel(channelId: string) {
    testingChannelId = channelId;
    testResult = null;
    try {
      const result = await invoke<string>('test_notification_channel', { channelId });
      testResult = { channelId, success: true, message: result };
    } catch (e: any) {
      testResult = { channelId, success: false, message: String(e) };
    } finally {
      testingChannelId = null;
    }
  }

  function channelTypeLabel(type: NotificationChannelType): string {
    switch (type) {
      case 'slack': return 'Slack';
      case 'discord': return 'Discord';
      case 'webhook': return 'Webhook';
      default: return type;
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h3 class="text-sm font-semibold text-text-primary mb-3">Sequence Automation</h3>

    <div class="space-y-3">
      <div>
        <label class="block text-xs text-text-muted mb-1">Max Concurrent Executions</label>
        <input type="number" bind:value={$settings.sequences.max_concurrent_executions}
          min="1" max="10"
          class="w-24 px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
      </div>

      <div>
        <label class="block text-xs text-text-muted mb-1">Default Node Timeout (seconds)</label>
        <input type="number" bind:value={$settings.sequences.default_timeout}
          min="30" max="3600"
          class="w-24 px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
      </div>

      <div>
        <label class="block text-xs text-text-muted mb-1">Execution History (days)</label>
        <input type="number" bind:value={$settings.sequences.execution_history_days}
          min="1" max="365"
          class="w-24 px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
      </div>

      <div class="pt-2 border-t border-border/50">
        <h4 class="text-xs font-semibold text-text-secondary mb-2">Rate Limiting</h4>
        <div class="space-y-2">
          <div>
            <label class="block text-xs text-text-muted mb-1">Max Concurrent Prompts</label>
            <input type="number" bind:value={$settings.sequences.max_concurrent_prompts}
              min="1" max="20"
              class="w-24 px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
            <span class="text-[10px] text-text-muted ml-2">Maximum prompt nodes running simultaneously across all sequences</span>
          </div>
          <div>
            <label class="block text-xs text-text-muted mb-1">Default Provider RPM</label>
            <input type="number" bind:value={$settings.sequences.default_provider_rpm}
              min="1" max="1000"
              class="w-24 px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
            <span class="text-[10px] text-text-muted ml-2">Requests per minute per provider</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Event Triggers Section -->
  <div class="border-t border-border pt-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <h3 class="text-sm font-semibold text-text-primary">Event Triggers</h3>
        <p class="text-xs text-text-muted mt-0.5">Sequences that fire automatically in response to events.</p>
      </div>
      <button
        class="px-3 py-1 text-xs font-medium rounded border border-border text-text-muted hover:text-text-primary hover:border-text-muted transition-colors"
        onclick={loadEventTriggers}
      >
        Refresh
      </button>
    </div>
    {#if eventTriggers.length === 0}
      <div class="p-3 rounded border border-border/50 bg-surface-elevated/50">
        <p class="text-xs text-text-muted italic">No event triggers configured. Add triggers to sequence definitions using the <code>triggers</code> field.</p>
      </div>
    {:else}
      <div class="space-y-2">
        {#each eventTriggers as trigger}
          <div class="p-2 rounded border border-border/50 bg-surface-elevated/50 flex items-center justify-between">
            <div class="flex-1">
              <div class="text-xs font-medium text-text-primary">{trigger.sequence_name}</div>
              <div class="text-[10px] text-text-muted flex items-center gap-2 mt-0.5">
                <span class="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">{trigger.event_type}</span>
                {#if trigger.cooldown_ms > 0}
                  <span>cooldown: {trigger.cooldown_ms / 1000}s</span>
                {/if}
                {#if trigger.max_per_day < 4294967295}
                  <span>max/day: {trigger.max_per_day}</span>
                {/if}
                {#if trigger.today_count > 0}
                  <span>today: {trigger.today_count}x</span>
                {/if}
              </div>
            </div>
            <span class="w-2 h-2 rounded-full {trigger.active ? 'bg-green-400' : 'bg-gray-500'}"></span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="border-t border-border pt-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <h3 class="text-sm font-semibold text-text-primary">Notification Channels</h3>
        <p class="text-xs text-text-muted mt-0.5">Configure external notification channels (Slack, Discord, Webhook) for sequences.</p>
      </div>
      {#if !showAddForm}
        <button
          class="px-3 py-1 text-xs font-medium rounded border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
          onclick={() => { showAddForm = true; }}
        >
          Add Channel
        </button>
      {/if}
    </div>

    <!-- Add Channel Form -->
    {#if showAddForm}
      <div class="p-3 rounded border border-accent/30 bg-surface-elevated space-y-3 mb-4">
        <h4 class="text-xs font-semibold text-text-primary">New Notification Channel</h4>

        <div>
          <label class="block text-xs text-text-muted mb-1">Name</label>
          <input
            type="text"
            bind:value={newName}
            placeholder="e.g. My Slack Channel"
            class="w-full px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
          />
          {#if newName.trim()}
            <p class="text-[10px] text-text-muted mt-0.5">ID: {slugify(newName)}</p>
          {/if}
        </div>

        <div>
          <label class="block text-xs text-text-muted mb-1">Type</label>
          <select
            bind:value={newType}
            class="w-full px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
          >
            <option value="slack">Slack</option>
            <option value="discord">Discord</option>
            <option value="webhook">Webhook</option>
          </select>
        </div>

        <div>
            <label class="block text-xs text-text-muted mb-1">Webhook URL</label>
            <input
              type="url"
              bind:value={newWebhookUrl}
              placeholder={newType === 'slack' ? 'https://hooks.slack.com/services/...' : newType === 'discord' ? 'https://discord.com/api/webhooks/...' : 'https://...'}
              class="w-full px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
            />
          </div>

        {#if newType === 'webhook'}
          <div>
            <label class="block text-xs text-text-muted mb-1">Headers</label>
            <div class="space-y-1 mb-2">
              {#each Object.entries(newHeaders) as [key, value]}
                <div class="flex items-center gap-1">
                  <span class="text-xs text-text-secondary font-mono flex-1 truncate">{key}: {value}</span>
                  <button
                    class="text-text-muted hover:text-red-400 text-xs"
                    onclick={() => removeNewHeader(key)}
                  >
                    x
                  </button>
                </div>
              {/each}
            </div>
            <div class="flex items-center gap-1">
              <input
                type="text"
                bind:value={newHeaderKey}
                placeholder="Header name"
                class="flex-1 px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              />
              <input
                type="text"
                bind:value={newHeaderValue}
                placeholder="Value"
                class="flex-1 px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              />
              <button
                class="px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-text-primary hover:border-accent transition-colors"
                onclick={addNewHeader}
                disabled={!newHeaderKey.trim()}
              >
                +
              </button>
            </div>
          </div>
        {/if}

        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" bind:checked={newEnabled} class="rounded border-border accent-accent" />
          <span class="text-xs text-text-secondary">Enabled</span>
        </label>

        <div class="flex items-center gap-2 pt-1">
          <button
            class="px-3 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
            onclick={addChannel}
            disabled={!newName.trim() || !slugify(newName) || !newWebhookUrl.trim()}
          >
            Add
          </button>
          <button
            class="px-3 py-1 text-xs font-medium rounded border border-border text-text-muted hover:text-text-primary transition-colors"
            onclick={resetNewForm}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

    <!-- Channel List -->
    {#if $settings.sequences.notification_channels.length === 0 && !showAddForm}
      <p class="text-xs text-text-muted italic">No notification channels configured.</p>
    {:else}
      <div class="space-y-2">
        {#each $settings.sequences.notification_channels as channel, i}
          <div class="rounded border border-border {channel.enabled ? '' : 'opacity-60'}">
            <!-- Channel header row -->
            <div class="flex items-center justify-between p-2">
              <div class="flex items-center gap-2 min-w-0">
                <button
                  class="w-8 h-4 rounded-full relative transition-colors {channel.enabled ? 'bg-accent' : 'bg-surface-elevated border border-border'}"
                  onclick={() => toggleChannelEnabled(i)}
                  title={channel.enabled ? 'Disable' : 'Enable'}
                >
                  <span class="absolute top-0.5 {channel.enabled ? 'right-0.5' : 'left-0.5'} w-3 h-3 rounded-full bg-white transition-all shadow-sm"></span>
                </button>
                <span class="text-xs font-medium text-text-primary truncate">{channel.name}</span>
                <span class="px-1.5 py-0.5 text-[10px] rounded bg-surface-elevated text-text-muted shrink-0">
                  {channelTypeLabel(channel.channel_type)}
                </span>
              </div>
              <div class="flex items-center gap-1 shrink-0 ml-2">
                <button
                  class="px-2 py-0.5 text-[10px] rounded border border-border text-text-muted hover:text-accent hover:border-accent transition-colors disabled:opacity-50"
                  onclick={() => testChannel(channel.id)}
                  disabled={testingChannelId === channel.id}
                >
                  {testingChannelId === channel.id ? 'Sending...' : 'Test'}
                </button>
                <button
                  class="px-2 py-0.5 text-[10px] rounded border border-border text-text-muted hover:text-text-primary hover:border-accent transition-colors"
                  onclick={() => editingChannelId === channel.id ? cancelEditing() : startEditing(channel)}
                >
                  {editingChannelId === channel.id ? 'Close' : 'Edit'}
                </button>
                <button
                  class="px-2 py-0.5 text-[10px] rounded border border-border text-text-muted hover:text-red-400 hover:border-red-400 transition-colors"
                  onclick={() => removeChannel(i)}
                >
                  Remove
                </button>
              </div>
            </div>

            <!-- Test result -->
            {#if testResult && testResult.channelId === channel.id}
              <div class="px-2 pb-2">
                <p class="text-[10px] {testResult.success ? 'text-green-400' : 'text-red-400'}">
                  {testResult.message}
                </p>
              </div>
            {/if}

            <!-- Edit form (inline expand) -->
            {#if editingChannelId === channel.id}
              <div class="p-3 border-t border-border space-y-3 bg-surface-elevated/50">
                <div>
                  <label class="block text-xs text-text-muted mb-1">Name</label>
                  <input
                    type="text"
                    bind:value={editName}
                    class="w-full px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
                  />
                </div>

                <div>
                  <label class="block text-xs text-text-muted mb-1">Type</label>
                  <select
                    bind:value={editType}
                    class="w-full px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
                  >
                    <option value="slack">Slack</option>
                    <option value="discord">Discord</option>
                    <option value="webhook">Webhook</option>
                  </select>
                </div>

                <div>
                  <label class="block text-xs text-text-muted mb-1">Webhook URL</label>
                  <input
                    type="url"
                    bind:value={editWebhookUrl}
                    placeholder={editType === 'slack' ? 'https://hooks.slack.com/services/...' : editType === 'discord' ? 'https://discord.com/api/webhooks/...' : 'https://...'}
                    class="w-full px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
                  />
                </div>

                {#if editType === 'webhook'}
                  <div>
                    <label class="block text-xs text-text-muted mb-1">Headers</label>
                    <div class="space-y-1 mb-2">
                      {#each Object.entries(editHeaders) as [key, value]}
                        <div class="flex items-center gap-1">
                          <span class="text-xs text-text-secondary font-mono flex-1 truncate">{key}: {value}</span>
                          <button
                            class="text-text-muted hover:text-red-400 text-xs"
                            onclick={() => removeEditHeader(key)}
                          >
                            x
                          </button>
                        </div>
                      {/each}
                    </div>
                    <div class="flex items-center gap-1">
                      <input
                        type="text"
                        bind:value={editHeaderKey}
                        placeholder="Header name"
                        class="flex-1 px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
                      />
                      <input
                        type="text"
                        bind:value={editHeaderValue}
                        placeholder="Value"
                        class="flex-1 px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
                      />
                      <button
                        class="px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-text-primary hover:border-accent transition-colors"
                        onclick={addEditHeader}
                        disabled={!editHeaderKey.trim()}
                      >
                        +
                      </button>
                    </div>
                  </div>
                {/if}

                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" bind:checked={editEnabled} class="rounded border-border accent-accent" />
                  <span class="text-xs text-text-secondary">Enabled</span>
                </label>

                <div class="flex items-center gap-2 pt-1">
                  <button
                    class="px-3 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
                    onclick={() => saveEditing(i)}
                    disabled={!editName.trim() || !editWebhookUrl.trim()}
                  >
                    Save
                  </button>
                  <button
                    class="px-3 py-1 text-xs font-medium rounded border border-border text-text-muted hover:text-text-primary transition-colors"
                    onclick={cancelEditing}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
