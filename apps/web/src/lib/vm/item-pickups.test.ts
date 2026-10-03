import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe, expect } from 'vitest';

import { parseEldenRingData } from '../er-save-parser';
import type { Slot } from '../save-dto';
import { inventoryDbView } from './inventory';
import { isEventFlagSet, pickupState, summarizePickups } from './item-pickups';
import { ALL_ITEM_PINS } from './map-pins';

// Per-LOCATION pickup detection against the committed `ER0000.sl2` fixture (5 characters,
// base game — one owns Shadow of the Erdtree but none has entered the Land of Shadow). The
// point of these tests is that "collected" comes from each pickup lot's event flag, NOT from
// the inventory: a consumed item still reads as picked up, and owning one copy doesn't mark
// the item's other spots.

// Walk up to the repo root (see save-parser.test.ts for why not cwd/import.meta.url).
const REPO_ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'turbo.jsonc'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
})();
const BASE_SAVE = join(REPO_ROOT, 'packages', 'save-parser', 'test', 'fixtures', 'ER0000.sl2');

const loadSlots = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(BASE_SAVE);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const slots = parseEldenRingData(buffer).slots.filter(
    (s) => s.player_game_data.character_name.length > 0,
  );
  expect(slots.length).toBeGreaterThan(0);
  return slots;
});

const PLACEMENT_TYPE = {
  WEAPON: 'weapon',
  ARMOR: 'armor',
  ACCESSORY: 'talisman',
  ITEM: 'goods',
  AOW: 'ash-of-war',
} as const;

/** `${placementType}:${itemId}` → total quantity held (inventory + storage chest). */
function ownedQuantities(slot: Slot): Map<string, number> {
  const owned = new Map<string, number>();
  for (const item of inventoryDbView(slot).items) {
    if (!(item.type in PLACEMENT_TYPE)) continue;
    const k = `${PLACEMENT_TYPE[item.type as keyof typeof PLACEMENT_TYPE]}:${item.item_id}`;
    owned.set(k, (owned.get(k) ?? 0) + item.quantity);
  }
  return owned;
}

describe('item pickups — no save', () => {
  it('classifies flagless lots as respawning and flagged lots as one-time', () => {
    const summary = summarizePickups(undefined);
    expect(summary.respawning + summary.oneTime).toBe(ALL_ITEM_PINS.length);
    expect(summary.oneTime).toBeGreaterThan(1000);
    expect(summary.respawning).toBeGreaterThan(1000);
    expect(summary.pickedUp).toBe(0);
    for (const { pin, state } of summary.states) {
      // Only flagless ENEMY drops respawn; a flagless treasure / scripted award is untracked.
      expect(state).toBe(pin.flagId === 0 && pin.source === 'enemy' ? 'respawns' : 'unknown');
    }
  });
});

it.layer(NodeServices.layer)('item pickups — per-location, from event flags (ER0000.sl2)', (it) => {
  it.effect('reads picked-up state per slot; nothing in the Land of Shadow', () =>
    Effect.gen(function* () {
      for (const slot of yield* loadSlots) {
        const flags = slot.event_flags.flags;
        const summary = summarizePickups(flags);
        expect(summary.pickedUp).toBeGreaterThan(0);
        expect(summary.pickedUp).toBeLessThan(summary.oneTime);
        // No character in this fixture has entered the DLC (slot 5 owns it but never went
        // in), so EVERY one-time pickup on the Land of Shadow map (master M10) is available.
        // Regression: EMEVD-traced base-game award lots used to be mis-pinned onto m61 tiles
        // via tiny colliding entity ids and read as "collected DLC pickups".
        const dlc = summary.states.filter((s) => s.pin.master === 'M10' && s.state !== 'respawns');
        expect(dlc.length).toBeGreaterThan(500);
        expect(dlc.filter((s) => s.state === 'picked-up')).toEqual([]);
        // `pickupState` is exactly the pin's flag bit.
        for (const { pin, state } of summary.states) {
          if (pin.flagId === 0) continue;
          expect(state === 'picked-up').toBe(isEventFlagSet(flags, pin.flagId));
        }
      }
    }),
  );

  it.effect('a picked-up spot stays picked up even when the item is no longer held', () =>
    Effect.gen(function* () {
      for (const slot of yield* loadSlots) {
        const owned = ownedQuantities(slot);
        // Consumables (runes, stones, materials) get used up — inventory says "missing",
        // but the lot flag proves they were collected from that exact spot.
        const pickedButGone = ALL_ITEM_PINS.filter(
          (pin) =>
            pickupState(pin, slot.event_flags.flags) === 'picked-up' &&
            (owned.get(`${pin.itemType}:${pin.itemId}`) ?? 0) === 0,
        );
        expect(pickedButGone.length).toBeGreaterThan(0);
      }
    }),
  );

  it.effect("owning an item doesn't mark its other locations as picked up", () =>
    Effect.gen(function* () {
      const slots = yield* loadSlots;
      // Use the most-progressed character: plenty of items owned AND still out there.
      const slot = slots.reduce((a, b) =>
        b.player_game_data.level > a.player_game_data.level ? b : a,
      );
      const owned = ownedQuantities(slot);
      // Items held in the inventory that still have an uncollected one-time spot on the map
      // — an inventory-based check would wrongly hide those spots.
      const ownedButAvailable = ALL_ITEM_PINS.filter(
        (pin) =>
          pickupState(pin, slot.event_flags.flags) === 'available' &&
          (owned.get(`${pin.itemType}:${pin.itemId}`) ?? 0) > 0,
      );
      expect(ownedButAvailable.length).toBeGreaterThan(0);
      // And the same item can be both picked up at one spot and available at another.
      const byItem = new Map<string, Set<string>>();
      for (const pin of ALL_ITEM_PINS) {
        const k = `${pin.itemType}:${pin.itemId}`;
        const states = byItem.get(k) ?? new Set();
        states.add(pickupState(pin, slot.event_flags.flags));
        byItem.set(k, states);
      }
      const mixed = [...byItem.values()].filter((s) => s.has('picked-up') && s.has('available'));
      expect(mixed.length).toBeGreaterThan(0);
    }),
  );
});
