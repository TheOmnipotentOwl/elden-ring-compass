// Inventory catalog — the install-derived replacement for the old `erdb.ts` (`ERDB` +
// `useAllErdb`). Joins the catalog rows (the dataset grouping lives in the react-free
// `inventory-catalog-data.ts`) with the active save's ownership (quantity + weapon
// upgrade level + map coordinates).
import { useMemo } from 'react';

import { useSelectedSlot } from '@/stores/slot-selection-store';
import { CATALOG, TABLE_PLACEMENT_TYPE, type InventoryTableType } from './inventory-catalog-data';
import { usePickupFlags } from './use-pickup-flags';
import { inventoryDbView } from './vm/inventory';
import { pickupState } from './vm/item-pickups';
import { itemPins } from './vm/map-pins';

export { CATALOG, TABLE_PLACEMENT_TYPE, type InventoryTableType } from './inventory-catalog-data';

/** A catalog row joined with the active save's ownership. */
export type WithOwnership<T> = T & {
  quantity: number;
  weaponUpgradeLevel: number;
  // Whether the item has any extracted overworld pickup location (drives map
  // pinning via `enableRowSelection`). The actual pins live in `itemIdToPins`.
  hasCoords: boolean;
  // How many overworld pins selecting this row drops on the map — the visible
  // "Locations" column. `hasCoords === (locationCount > 0)`.
  locationCount: number;
  // Distinct one-time pickups behind those pins (distinct non-zero pickup flags — one flag
  // can back several pins, e.g. a multi-phase NPC placed at each quest position) and how
  // many of THOSE the save has collected — from event flags, not inventory.
  oneTimeLocationCount: number;
  pickedUpCount: number;
  // Whether `pickedUpCount` was read from save flags (false: no save, or a shared link).
  pickupKnown: boolean;
};

/** Broad shape every joined row satisfies (used where the category isn't statically known). */
export type InventoryRow = WithOwnership<{
  id: number;
  name: string;
  icon: number;
  rarity: string;
}>;

export type InventoryTableResult = {
  items: InventoryRow[];
  ownedCount: number;
};

/**
 * Per-category catalog joined with save ownership. Mirrors the old `useAllErdb` contract:
 * `{ items, ownedCount }` per table. Owned quantity sums duplicate stacks; weapons show their
 * highest upgrade level (appended to the name as ` +N`, as before). Items are typed broadly
 * (`InventoryRow`); per-column field access is typed via `CATALOG` in the table definitions.
 */
export function useInventoryTables(): Record<InventoryTableType, InventoryTableResult> {
  const slot = useSelectedSlot();
  const pickupFlags = usePickupFlags();

  return useMemo(() => {
    const owned = new Map<number, { quantity: number; upgradeLevel: number }>();
    if (slot) {
      for (const item of inventoryDbView(slot).items) {
        const cur = owned.get(item.item_id);
        owned.set(item.item_id, {
          quantity: (cur?.quantity ?? 0) + item.quantity,
          upgradeLevel: Math.max(cur?.upgradeLevel ?? 0, item.upgrade_level),
        });
      }
    }

    const join = (
      rows: ReadonlyArray<{
        id: number;
        name: string;
        icon: number;
        rarity: string;
      }>,
      placementType: string,
    ): InventoryTableResult => {
      const items: InventoryRow[] = rows
        // Drop the datasets' `[ERROR]Type N` placeholder rows (48 in WEAPONS, 54 in ARMOR,
        // 1 in TALISMANS) — unused item slots that would otherwise render as junk table rows.
        .filter((row) => !row.name.startsWith('[ERROR]'))
        .map((row) => {
          const o = owned.get(row.id);
          const weaponUpgradeLevel = o?.upgradeLevel ?? 0;
          const pins = itemPins(placementType, row.id);
          const locationCount = pins.length;
          const oneTimeFlags = new Set<number>();
          const pickedFlags = new Set<number>();
          for (const pin of pins) {
            if (pin.flagId === 0) continue;
            oneTimeFlags.add(pin.flagId);
            if (pickupState(pin, pickupFlags) === 'picked-up') pickedFlags.add(pin.flagId);
          }
          return {
            ...row,
            quantity: o?.quantity ?? 0,
            weaponUpgradeLevel,
            name:
              weaponUpgradeLevel > 0 ? `${row.name} +${weaponUpgradeLevel.toString()}` : row.name,
            hasCoords: locationCount > 0,
            locationCount,
            oneTimeLocationCount: oneTimeFlags.size,
            pickedUpCount: pickedFlags.size,
            pickupKnown: pickupFlags !== undefined,
          };
        });
      return { items, ownedCount: items.filter((i) => i.quantity > 0).length };
    };

    return Object.fromEntries(
      Object.entries(CATALOG).map(([key, rows]) => [
        key,
        join(rows, TABLE_PLACEMENT_TYPE[key as InventoryTableType]),
      ]),
    ) as Record<InventoryTableType, InventoryTableResult>;
  }, [slot, pickupFlags]);
}
