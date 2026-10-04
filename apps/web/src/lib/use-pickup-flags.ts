import { useSelectedSlot } from '@/stores/slot-selection-store';

import { useEldenRingSave } from './atoms/save';

/**
 * The selected save's event-flag bitfield for per-location pickup checks
 * (`lib/vm/item-pickups.ts`), or `undefined` when pickup state is unknowable: no save
 * loaded, or a shared link — share payloads carry only grace / boss / map-fragment flags
 * (`lib/share/shareable-events.ts`), so a reconstructed slot would read every pickup as
 * "not picked up". With `undefined`, `pickupState` returns `'unknown'` and callers fall
 * back to inventory ownership.
 */
export function usePickupFlags(): Uint8Array | undefined {
  const slot = useSelectedSlot();
  const { isSharedView } = useEldenRingSave();
  return isSharedView ? undefined : slot?.event_flags.flags;
}
