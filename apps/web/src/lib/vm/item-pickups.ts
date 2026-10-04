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

/**
 * Whether a pickup counts as collected: its flag when the save has one for it; otherwise
 * (shared link, untracked lot) inventory ownership. `undefined` = can't tell (no save).
 */
export function isCollected(
  state: PickupState,
  owned: boolean,
  hasSave: boolean,
): boolean | undefined {
  if (state === 'respawns') return undefined;
  if (state === 'picked-up') return true;
  if (state === 'available') return false;
  return hasSave ? owned : undefined;
}

/**
 * The one status line every item pin uses, so the wording never mixes vocabularies:
 * "Farmable (respawns)" for repeatable drops; with a save, "Picked up" / "Not picked up"
 * for everything one-time; without one, "One-time pickup".
 */
export function pickupStatusLabel(state: PickupState, owned: boolean, hasSave: boolean): string {
  if (state === 'respawns') return 'Farmable (respawns)';
  const collected = isCollected(state, owned, hasSave);
  if (collected === undefined) return 'One-time pickup';
  return collected ? 'Picked up' : 'Not picked up';
}

/**
 * Item-location filters behind the map's item quick-selects. They narrow WHICH
 * locations of a pinned item show — e.g. "Farmable items" pins every item that has a
 * farmable drop, but only its farmable spots.
 */
export type ItemFilter =
  | 'all'
  | 'farmable'
  | 'one-time'
  | 'not-collected'
  | 'not-collected-one-time'
  | 'boss-drops';

export const ITEM_FILTER_LABEL: Record<ItemFilter, string> = {
  all: 'All item locations',
  farmable: 'Farmable items',
  'one-time': 'One-time pickups',
  'not-collected': 'Not collected (incl. farmable)',
  'not-collected-one-time': 'Not collected (excl. farmable)',
  'boss-drops': 'Boss drops',
};

export function matchesItemFilter(
  filter: ItemFilter,
  pin: Pick<ItemPin, 'bossDrop'>,
  state: PickupState,
  owned: boolean,
  hasSave: boolean,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'farmable':
      return state === 'respawns';
    case 'one-time':
      return state !== 'respawns';
    case 'not-collected':
      return state === 'respawns' || isCollected(state, owned, hasSave) !== true;
    case 'not-collected-one-time':
      return state !== 'respawns' && isCollected(state, owned, hasSave) !== true;
    case 'boss-drops':
      return pin.bossDrop;
  }
}

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
