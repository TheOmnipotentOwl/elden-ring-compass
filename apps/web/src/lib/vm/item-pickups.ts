import { eventFlagOffset } from '@elden-ring-compass/data';

import { ALL_ITEM_PINS, type ItemPin, type PlacedItemPin } from './map-pins';

/**
 * Per-LOCATION item pickup state, read from the save's event-flag bitfield — not from
 * the inventory. Every pickup lot (`ItemLotParam_map` treasure, unique `ItemLotParam_enemy`
 * drop, scripted award) carries a `getItemFlagId` that the game sets the moment THAT lot is
 * collected and never awards again (see `packages/extractor/src/game/item-lots.ts`). So:
 *
 *   - `respawns`  — an ENEMY drop lot with no flag (0): a farmable / repeatable drop.
 *   - `picked-up` — the flag is set: that pickup was collected (even if the item was since
 *                   consumed, sold, or dropped). One flag can back several pins — e.g. a
 *                   multi-phase NPC placed at each quest position — so this means "this
 *                   pickup is collected", not necessarily "collected from this pin".
 *   - `available` — the flag is clear: still out there, even if you own another copy.
 *   - `unknown`   — can't tell: no save flags (none loaded, or a shared link — see
 *                   `lib/use-pickup-flags.ts`), or a one-time map/event lot with no flag.
 */
export type PickupState = 'picked-up' | 'available' | 'respawns' | 'unknown';

/** Whether event flag `flagId` is set in a save's event-flag bitfield. */
export function isEventFlagSet(flags: Uint8Array, flagId: number): boolean {
  const offset = eventFlagOffset(flagId);
  if (!offset) return false;
  const [byteOffset, bitPos] = offset;
  return ((flags[byteOffset] ?? 0) & (1 << bitPos)) !== 0;
}

export function pickupState(
  pin: Pick<ItemPin, 'flagId' | 'source'>,
  flags: Uint8Array | undefined,
): PickupState {
  // Only enemy drop tables repeat; a flagless treasure / scripted award is still one-time,
  // just untracked.
  if (pin.flagId === 0) return pin.source === 'enemy' ? 'respawns' : 'unknown';
  if (!flags) return 'unknown';
  return isEventFlagSet(flags, pin.flagId) ? 'picked-up' : 'available';
}

export const PICKUP_STATUS_LABEL: Record<PickupState, string> = {
  'picked-up': 'Picked up',
  available: 'Not picked up',
  respawns: 'Respawns (farmable)',
  unknown: 'One-time pickup',
};

export interface PickupSummary {
  /** One-time pickup pins (everything that doesn't respawn), total. */
  oneTime: number;
  /** One-time pickup pins whose flag is set in the save. */
  pickedUp: number;
  /** Farmable enemy-drop pins (no pickup flag). */
  respawning: number;
  /** Per-pin state, aligned with `ALL_ITEM_PINS`. */
  states: ReadonlyArray<{ pin: PlacedItemPin; state: PickupState }>;
}

/**
 * Classify every placed pickup on the map against a save's flags — the data behind
 * "what respawns / what's permanently collected / what's still out there".
 */
export function summarizePickups(flags: Uint8Array | undefined): PickupSummary {
  let oneTime = 0;
  let pickedUp = 0;
  let respawning = 0;
  const states = ALL_ITEM_PINS.map((pin) => {
    const state = pickupState(pin, flags);
    if (state === 'respawns') respawning++;
    else {
      oneTime++;
      if (state === 'picked-up') pickedUp++;
    }
    return { pin, state };
  });
  return { oneTime, pickedUp, respawning, states };
}
