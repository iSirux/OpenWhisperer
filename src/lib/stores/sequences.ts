import { writable, derived } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import type { SequenceDefinition, ScheduleInfo, EventTriggerInfo } from "$lib/types/sequence";

// Store for sequence definitions
export const sequences = writable<SequenceDefinition[]>([]);

// Derived stores
export const sequenceCount = derived(sequences, $s => $s.length);

// Load all sequences from backend
export async function loadSequences(): Promise<void> {
  try {
    const defs = await invoke<SequenceDefinition[]>("list_sequences");
    sequences.set(defs);
  } catch (error) {
    console.error("Failed to load sequences:", error);
  }
}

// Create/save a sequence from YAML
export async function saveSequence(yaml: string): Promise<SequenceDefinition | null> {
  try {
    const def = await invoke<SequenceDefinition>("import_sequence", { yaml });
    await loadSequences(); // Reload
    return def;
  } catch (error) {
    console.error("Failed to save sequence:", error);
    throw error;
  }
}

// Update an existing sequence
export async function updateSequence(id: string, yaml: string): Promise<void> {
  try {
    await invoke("save_sequence", { id, yaml });
    await loadSequences();
  } catch (error) {
    console.error("Failed to update sequence:", error);
    throw error;
  }
}

// Delete a sequence
export async function deleteSequence(id: string): Promise<void> {
  try {
    await invoke("delete_sequence", { id });
    await loadSequences();
  } catch (error) {
    console.error("Failed to delete sequence:", error);
    throw error;
  }
}

// Validate YAML without saving
export async function validateSequence(yaml: string): Promise<SequenceDefinition> {
  return invoke<SequenceDefinition>("validate_sequence", { yaml });
}

// Export a sequence as YAML
export async function exportSequence(id: string): Promise<string> {
  return invoke<string>("export_sequence", { id });
}

// Get a single sequence by ID
export function getSequenceById(id: string): SequenceDefinition | undefined {
  let result: SequenceDefinition | undefined;
  sequences.subscribe(s => {
    result = s.find(seq => seq.id === id);
  })();
  return result;
}

// Schedule management
export async function listSchedules(): Promise<ScheduleInfo[]> {
  try {
    return await invoke<ScheduleInfo[]>("list_schedules");
  } catch (error) {
    console.error("Failed to list schedules:", error);
    return [];
  }
}

export async function toggleSchedule(sequenceId: string, cron: string, enabled: boolean): Promise<void> {
  try {
    await invoke("toggle_schedule", { sequenceId, cron, enabled });
  } catch (error) {
    console.error("Failed to toggle schedule:", error);
    throw error;
  }
}

// Event triggers
export async function listEventTriggers(): Promise<EventTriggerInfo[]> {
  try {
    return await invoke<EventTriggerInfo[]>("list_event_triggers");
  } catch (error) {
    console.error("Failed to list event triggers:", error);
    return [];
  }
}

// AI generation
export async function generateSequenceYaml(description: string): Promise<string> {
  return invoke<string>("generate_sequence_yaml", { description });
}

export async function generateNodeConfig(nodeType: string, description: string, context: string): Promise<unknown> {
  return invoke("generate_node_config", { nodeType, description, context });
}
