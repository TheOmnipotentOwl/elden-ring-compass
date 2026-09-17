import { Schema } from 'effect';
import { Atom } from 'effect/unstable/reactivity';
import { useAtom } from '@effect/atom-react';
import { browserKvsRuntime } from '@/lib/atoms/kvs';

/**
 * Persisted map of entity-id → manually-toggled state.
 *
 * Keys are stringified event-flag IDs (matching the `id` field on boss / grace
 * rows). Values are `true` when the user has manually marked the entity as done
 * and `false` (or absent) otherwise.
 *
 * Backed by localStorage via the shared KVS runtime so state survives page
 * refreshes. When a save is also connected, this is shown alongside (not instead
 * of) the live save-file data so the user can compare.
 */
const manualOverridesAtom = Atom.kvs({
  runtime: browserKvsRuntime,
  key: 'manual-overrides-v1',
  schema: Schema.Record({ key: Schema.String, value: Schema.Boolean }),
  defaultValue: () => ({}) as Record<string, boolean>,
});

/** Returns `[overrides, setOverrides]` — a controlled record of manual toggles. */
export const useManualOverrides = () => useAtom(manualOverridesAtom);

/** Toggle a single entity by its string id, updating the persisted record. */
export function useManualToggle(id: string) {
  const [overrides, setOverrides] = useManualOverrides();
  const isManuallyDone = overrides[id] ?? false;
  const toggle = () => setOverrides({ ...overrides, [id]: !isManuallyDone });
  return { isManuallyDone, toggle };
}
