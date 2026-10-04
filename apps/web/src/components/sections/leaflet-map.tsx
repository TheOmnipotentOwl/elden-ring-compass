/**
 * Client-only react-leaflet map over the extractor-generated tile pyramid.
 *
 * This module imports `leaflet` (which touches `window` at import) and the
 * leaflet CSS, so it must only ever be loaded via a dynamic `import()` on the
 * client — see `map-section.tsx`, which lazy-loads it behind a mounted guard.
 *
 * Geometry: tiles are a power-of-2 `{z}/{y}/{x}` pyramid (google layout) over a
 * `width×height` master. We use `CRS.Simple` and inline the tiny
 * leaflet-rastercoords projection — pixel↔latlng via `unproject(px, nativeZoom)`,
 * where `nativeZoom = ceil(log2(maxDim/tileSize))` (== manifest.maxNativeZoom).
 *
 * Markers are precomputed master-pixel pins (`MapPin`) — extracted overworld
 * coords (graces / field bosses) or the corrected wiki fallback — unprojected at
 * native zoom. See `map-affine.ts` for the projection and its derivation.
 */
import 'leaflet/dist/leaflet.css';

import {
  CRS,
  divIcon,
  GridLayer,
  type LatLng,
  type LatLngBounds,
  latLngBounds,
  point,
  TileLayer as LeafletTileLayer,
} from 'leaflet';
import { ExternalLinkIcon } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet';

import { MAP_TILES_BASE, type MapManifest, type TileIndex } from '@/lib/map-tiles';
import type { PickupState } from '@/lib/vm/item-pickups';
import { wikiNameForBoss, wikiPageUrl } from '@/lib/wiki';

/** What kind of thing a pin represents — drives its hover/popup content. */
type PinKind = 'grace' | 'boss' | 'item' | 'player' | 'bloodstain';

/** A map pin already resolved to a specific master (`M00`/`M10`) + master pixel. */
export interface MapPin {
  kind: PinKind;
  name: string;
  category: string;
  description: string;
  master: string;
  px: number;
  py: number;
  /**
   * For graces/bosses/items: whether this point is "discovered" (grace found /
   * boss defeated / item owned). Drives a brighter vs. muted shade of the category
   * colour. Absent for the player marker, which has no such state.
   */
  discovered?: boolean;
  /**
   * Bloodstain only: runes currently recoverable on the ground at this spot.
   * Drives the hover tooltip + popup ("N runes on the ground"). Absent for all
   * other pins.
   */
  runes?: number;

  // --- enrichment (optional, populated per kind in map-section.tsx) ---
  /** One-line status shown in the hover tooltip + as a popup badge. */
  status?: string;
  /** Human map area ("Stormveil Castle", a grace's region, …). */
  area?: string;
  /** Boss category badges ("Demigod", "Shardbearer", …). */
  badges?: string[];
  /** Boss reward drop (Remembrance / Heart of Bayle). */
  reward?: { name: string; iconUrl?: string };
  /** Item: source label ("Treasure" | "Drop" | "Drop · approx. area"). */
  sourceLabel?: string;
  /** Item: drop chance as a percentage (omitted when guaranteed). */
  chancePct?: number;
  /**
   * Item: this LOCATION's pickup state from the save's event flags
   * (`lib/vm/item-pickups.ts`) — independent of inventory ownership.
   */
  pickup?: PickupState;
  /** Item: how many of this item the player owns. */
  quantity?: number;
  /** Item: how many pins this item places across the map. */
  locationCount?: number;
  /**
   * Item: resolved wiki page name (`wikiNameForItem`) — differs from `name` for
   * affinity/upgrade variants, absent when the wiki has no page for the item.
   */
  wikiName?: string;
}

const BASE_LAYER = 'base';

/** Pack a tile coord into one int key (x, y < 2^16 — far above any zoom's grid). */
const tileKey = (x: number, y: number) => (x << 16) | y;

/**
 * A `TileLayer` that won't even request tiles the extractor never wrote (the blank
 * corners dropped by `skipBlanks`). Leaflet's `_isValidTile` is the gate it calls
 * before creating each tile — we AND the default bounds check with an existence
 * lookup, so missing tiles produce neither a request nor a 404. Implemented
 * imperatively (not via react-leaflet's `<TileLayer>`) because the gate is a
 * subclass override, not an option.
 */
function ExistenceTileLayer({
  url,
  tileSize,
  maxNativeZoom,
  bounds,
  exists,
}: {
  url: string;
  tileSize: number;
  maxNativeZoom: number;
  bounds: LatLngBounds;
  exists: (z: number, x: number, y: number) => boolean;
}) {
  const map = useMap();
  useEffect(() => {
    // `.extend()` loses TileLayer's `(url, options)` constructor signature in
    // @types/leaflet, so re-assert it.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- extend() result re-asserted to TileLayer's ctor type (see comment above)
    const ExistenceTL = LeafletTileLayer.extend({
      _isValidTile(coords: { x: number; y: number; z: number }) {
        // Our tile pyramids are SPARSE — the extractor's `skipBlanks` drops
        // fully-transparent tiles and most maps don't span the whole grid — so by
        // default Leaflet would request every tile within the layer bounds and get
        // a flood of 404s for the ones that were never written. We override
        // `_isValidTile` to additionally consult the on-disk manifest (`exists`),
        // so Leaflet simply never requests a tile that isn't there.
        // `GridLayer._isValidTile` applies the `bounds`/`noWrap` envelope; we add existence.
        // @types/leaflet doesn't expose GridLayer.prototype._isValidTile; reach
        // the private envelope check through a typed view of the prototype.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see comment above
        const gridProto = GridLayer.prototype as unknown as {
          _isValidTile: (c: { x: number; y: number; z: number }) => boolean;
        };
        const inEnvelope = gridProto._isValidTile.call(this, coords);
        return inEnvelope && exists(coords.z, coords.x, coords.y);
      },
      // Cast: extend() loses TileLayer's (url, options) ctor signature in @types/leaflet (see comment above)
    }) as unknown as typeof LeafletTileLayer;
    const layer = new ExistenceTL(url, {
      tileSize,
      minNativeZoom: 0,
      maxNativeZoom,
      noWrap: true,
      bounds,
    });
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, url, tileSize, maxNativeZoom, bounds, exists]);
  return null;
}

// Marker colour by pin category — graces gold, bosses red, item pickups cyan
// (mirrors the design kit's PIN_COLOR). Pins are otherwise identical teardrops;
// the colour is what distinguishes them at a glance. Each category gets a brighter
// "discovered" shade and a muted one so you can tell, at a glance, found-vs-
// undiscovered graces, defeated-vs-remaining bosses, and collected-vs-uncollected
// items apart. See the legend in `map-section.tsx`.
const PIN_COLOR = {
  graceOn: '#ecbd4a',
  graceOff: '#8c7a3e',
  bossOn: '#e24a4a',
  bossOff: '#8a4040',
  itemOn: '#3cbfdb',
  itemOff: '#356e7a',
  default: '#a89a87',
} as const;

function categoryColor(category: string, discovered?: boolean): string {
  const c = category.toLowerCase();
  if (c.includes('grace')) return discovered === false ? PIN_COLOR.graceOff : PIN_COLOR.graceOn;
  if (c.includes('boss')) return discovered === false ? PIN_COLOR.bossOff : PIN_COLOR.bossOn;
  if (c.includes('treasure') || c.includes('drop'))
    return discovered === false ? PIN_COLOR.itemOff : PIN_COLOR.itemOn;
  return PIN_COLOR.default;
}

// One divIcon per colour, cached and shared across markers.
const pinIconCache = new Map<string, ReturnType<typeof divIcon>>();
function pinIcon(category: string, discovered?: boolean) {
  const color = categoryColor(category, discovered);
  const cached = pinIconCache.get(color);
  if (cached) return cached;
  const html =
    `<svg width="24" height="24" viewBox="0 0 24 24" fill="${color}" stroke="#fff" ` +
    `stroke-width="1.5" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))">` +
    `<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>` +
    `<circle cx="12" cy="10" r="2.6" fill="#fff" stroke="none"/></svg>`;
  const ic = divIcon({
    className: '',
    html,
    iconSize: [24, 24],
    iconAnchor: [12, 22],
    popupAnchor: [0, -20],
  });
  pinIconCache.set(color, ic);
  return ic;
}

/**
 * Stacked-pin marker for several pins on one spot (a multi-item treasure lot, a boss and
 * its drops, …): the same teardrop, coloured by the most "outstanding" pin in the stack,
 * with the count in place of the dot. Cached per colour + label like {@link pinIcon}.
 */
function stackIcon(pins: readonly MapPin[]) {
  const lead = pins.find((p) => p.discovered === false) ?? pins[0];
  const color = lead ? categoryColor(lead.category, lead.discovered) : PIN_COLOR.default;
  const label = pins.length > 9 ? '9+' : pins.length.toString();
  const key = `${color}:${label}`;
  const cached = pinIconCache.get(key);
  if (cached) return cached;
  const html =
    `<svg width="28" height="28" viewBox="0 0 24 24" fill="${color}" stroke="#fff" ` +
    `stroke-width="1.5" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))">` +
    `<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>` +
    `<text x="12" y="13" text-anchor="middle" font-size="${label.length > 1 ? 7 : 9}" ` +
    `font-weight="700" fill="#fff" stroke="none" font-family="system-ui,sans-serif">${label}</text></svg>`;
  const ic = divIcon({
    className: '',
    html,
    iconSize: [28, 28],
    iconAnchor: [14, 26],
    popupAnchor: [0, -24],
  });
  pinIconCache.set(key, ic);
  return ic;
}

/** Distinct "you are here" marker — a pulsing amber dot, centered on its point. */
const playerIcon = divIcon({
  className: '',
  html:
    '<div style="width:18px;height:18px;border-radius:50%;background:#f59e0b;' +
    'border:3px solid #fff;box-shadow:0 0 0 2px #f59e0b,0 0 8px 2px rgba(245,158,11,.8)"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
  popupAnchor: [0, -10],
});

/**
 * "Lost runes" bloodstain marker — a glowing gold diamond, deliberately a
 * different shape/colour from the amber player dot so the two never read as the
 * same thing. Shown where the player last died with runes still on the ground.
 */
const bloodstainIcon = divIcon({
  className: '',
  html:
    '<div style="width:14px;height:14px;transform:rotate(45deg);background:#facc15;' +
    'border:2px solid #fff;box-shadow:0 0 8px 3px rgba(250,204,21,.85),0 1px 2px rgba(0,0,0,.55)"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  popupAnchor: [0, -8],
});

/**
 * "Last death (runes already recovered)" marker — a faded, hollow gold diamond,
 * no glow. Same shape as {@link bloodstainIcon} so it reads as the same kind of
 * thing, but clearly inactive: it's the retained last-death spot from a save
 * whose bloodstain has been cleared (`runes <= 0`). See `useBloodstainPin`.
 */
const bloodstainRecoveredIcon = divIcon({
  className: '',
  html:
    '<div style="width:13px;height:13px;transform:rotate(45deg);background:transparent;' +
    'border:2px solid rgba(250,204,21,.7);box-shadow:0 1px 2px rgba(0,0,0,.5);opacity:.85"></div>',
  iconSize: [13, 13],
  iconAnchor: [6.5, 6.5],
  popupAnchor: [0, -8],
});

/**
 * Hover tooltip — the at-a-glance summary: name + one-line status. Identical
 * across every pin kind so hovering always reads the same way. (The bloodstain's
 * `name` IS its status, e.g. "Lost runes", so its `status` line carries the runes.)
 */
function PinTooltipBody({ pin }: { pin: MapPin }) {
  return (
    <span>
      <strong>{pin.name}</strong>
      {pin.status && <span className='opacity-70'> · {pin.status}</span>}
    </span>
  );
}

/** A faded x/y readout, popup-only — handy for reporting a location. */
function PinCoords({ pin }: { pin: MapPin }) {
  return (
    <p className='mt-1 font-mono text-[11px] opacity-60'>
      x {Math.round(pin.px)}, y {Math.round(pin.py)}
    </p>
  );
}

/**
 * Click popup — the full detail card, laid out by `kind`. Every kind ends with the
 * shared faded coords line; the middle rows are the enriched, type-specific meta.
 */
function PinPopupBody({ pin }: { pin: MapPin }) {
  // Bosses and items have a reliably-named wiki page (validated by
  // scripts/wiki-link-check.ts); graces often don't, and player/bloodstain
  // markers have nothing to look up. Item pins use the pre-resolved `wikiName`
  // (base weapon for variants; absent when the wiki has no page for the item).
  const wikiName =
    pin.kind === 'boss'
      ? wikiNameForBoss(pin.name)
      : pin.kind === 'item'
        ? pin.wikiName
        : undefined;
  return (
    <div className='space-y-1 select-text'>
      <strong className='block'>{pin.name}</strong>

      {pin.kind === 'boss' && (
        <>
          {pin.badges && pin.badges.length > 0 && (
            <p className='text-[11px] opacity-70'>{pin.badges.join(' · ')}</p>
          )}
          {pin.area && <p>{pin.area}</p>}
          {pin.reward && (
            <p className='flex items-center gap-1.5'>
              {pin.reward.iconUrl && (
                <img src={pin.reward.iconUrl} alt='' className='size-5 shrink-0' />
              )}
              <span>{pin.reward.name}</span>
            </p>
          )}
        </>
      )}

      {pin.kind === 'grace' && (
        <>
          <p className='opacity-80'>Site of Grace</p>
          {pin.area && <p>{pin.area}</p>}
        </>
      )}

      {pin.kind === 'item' && (
        <>
          {pin.sourceLabel && <p className='opacity-80'>{pin.sourceLabel}</p>}
          {pin.chancePct !== undefined && <p>{pin.chancePct}% drop</p>}
          {pin.quantity !== undefined && <p>Owned: {pin.quantity}</p>}
          {pin.locationCount !== undefined && pin.locationCount > 1 && (
            <p className='opacity-70'>{pin.locationCount} locations on map</p>
          )}
        </>
      )}

      {pin.kind === 'player' && <p className='opacity-80'>Your current position</p>}

      {pin.kind === 'bloodstain' && pin.description && <p>{pin.description}</p>}

      {pin.status && pin.kind !== 'bloodstain' && pin.kind !== 'player' && (
        <p className='text-[11px] font-medium opacity-80'>{pin.status}</p>
      )}

      {/* Link-only — the wiki forbids scraping its content. */}
      {wikiName !== undefined && (
        <a
          href={wikiPageUrl(wikiName)}
          target='_blank'
          rel='noreferrer'
          className='flex w-fit items-center gap-1 text-[11px]'
        >
          Elden Ring Wiki <ExternalLinkIcon className='size-3' />
        </a>
      )}

      <PinCoords pin={pin} />
    </div>
  );
}

/**
 * Which pins may merge (stack or cluster): same kind (grace / boss / item) AND same
 * found-state (discovered / defeated / picked up vs. not) — so a merged badge never hides
 * an outstanding pin behind a done one.
 */
function mergeGroup(pin: MapPin): string {
  return `${pin.kind}:${pin.discovered === true ? 'done' : 'open'}`;
}

/**
 * Group pins of the same {@link mergeGroup} that sit on the same spot. Master pixels are
 * 1 world-unit (≈1 m), so rounding to the pixel merges exact co-locations — every item of
 * one treasure lot / one enemy's drop table shares its Part's coords — without merging
 * neighbours. A boss and its drops at one spot stay a boss pin plus an item stack.
 * Returns `[key, pins]`, the key unique per stack.
 */
function groupByLocation(pins: readonly MapPin[]): Array<[string, MapPin[]]> {
  const groups = new Map<string, MapPin[]>();
  for (const pin of pins) {
    const key = `${mergeGroup(pin)}:${Math.round(pin.px).toString()}:${Math.round(pin.py).toString()}`;
    const group = groups.get(key);
    if (group) group.push(pin);
    else groups.set(key, [pin]);
  }
  return [...groups];
}

/** One-line tooltip for a stack: "3 items here · 1 picked up · click to spread". */
function PinGroupTooltipBody({ pins }: { pins: readonly MapPin[] }) {
  const pickedUp = pins.filter((p) => p.pickup === 'picked-up').length;
  return (
    <span>
      <strong>
        {pins.length} {pins.every((p) => p.kind === 'item') ? 'items' : 'pins'} here
      </strong>
      {pickedUp > 0 && <span className='opacity-70'> · {pickedUp} picked up</span>}
      <span className='opacity-70'> · click to spread</span>
    </span>
  );
}

/** Grid cell size (screen px) for spread pins — a 24px teardrop plus a gap. */
const SPREAD_CELL_PX = 30;

/**
 * Screen-pixel offsets laying `n` stacked pins out on a compact, near-square grid
 * centred on their shared point (row by row; a partial last row is centred). Offsets are
 * for the pins' anchor (the teardrop tip), shifted down half an icon so the icons —
 * which sit above their tip — read as centred on the spot.
 */
function spreadOffsets(n: number): Array<readonly [number, number]> {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inRow = row === rows - 1 ? n - cols * (rows - 1) : cols;
    const x = (col - (inRow - 1) / 2) * SPREAD_CELL_PX;
    const y = (row - (rows - 1) / 2) * SPREAD_CELL_PX + 11;
    return [x, y] as const;
  });
}

/** Small hub dot left at a spread stack's true location (legs radiate from it). */
const spiderHubIcon = divIcon({
  className: '',
  html: '<div style="width:8px;height:8px;border-radius:50%;background:#fff;box-shadow:0 0 3px rgba(0,0,0,.7)"></div>',
  iconSize: [8, 8],
  iconAnchor: [4, 4],
});

function SinglePinMarker({
  pin,
  position,
  zIndexOffset,
}: {
  pin: MapPin;
  position: LatLng;
  zIndexOffset?: number;
}) {
  return (
    <Marker
      position={position}
      icon={pinIcon(pin.category, pin.discovered)}
      // Leaflet's default is 0; passing `undefined` would override it (NaN z-index).
      zIndexOffset={zIndexOffset ?? 0}
    >
      <Tooltip direction='top' offset={[0, -18]}>
        <PinTooltipBody pin={pin} />
      </Tooltip>
      <Popup>
        <PinPopupBody pin={pin} />
      </Popup>
    </Marker>
  );
}

/**
 * Screen-space radius (px) within which nearby spots of one {@link mergeGroup} merge into a
 * count badge. Deliberately tight — only pins that would visibly sit on top of each other.
 */
const CLUSTER_RADIUS_PX = 4;

/** Pins on one exact spot (see {@link groupByLocation}). */
interface Spot {
  key: string;
  pins: MapPin[];
  px: number;
  py: number;
}

/** Nearby spots merged at the current zoom — rendered as one count badge. */
interface Cluster {
  key: string;
  spots: Spot[];
  pins: MapPin[];
  px: number;
  py: number;
}

/**
 * Greedy distance clustering over a spatial hash (O(n)): each not-yet-claimed spot seeds
 * a cluster and claims every unclaimed spot within `radius` master pixels (only the 3×3
 * neighbouring cells can hold one). Deterministic for a given pin order.
 */
function clusterSpots(spots: readonly Spot[], radius: number): Cluster[] {
  const cellOf = (v: number) => Math.floor(v / radius);
  const buckets = new Map<string, Spot[]>();
  for (const spot of spots) {
    const k = `${cellOf(spot.px).toString()}:${cellOf(spot.py).toString()}`;
    const bucket = buckets.get(k);
    if (bucket) bucket.push(spot);
    else buckets.set(k, [spot]);
  }
  const claimed = new Set<Spot>();
  const r2 = radius * radius;
  const out: Cluster[] = [];
  for (const seed of spots) {
    if (claimed.has(seed)) continue;
    const members: Spot[] = [];
    const cx = cellOf(seed.px);
    const cy = cellOf(seed.py);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const spot of buckets.get(`${(cx + dx).toString()}:${(cy + dy).toString()}`) ?? []) {
          if (claimed.has(spot)) continue;
          const ox = spot.px - seed.px;
          const oy = spot.py - seed.py;
          if (ox * ox + oy * oy > r2) continue;
          claimed.add(spot);
          members.push(spot);
        }
      }
    }
    out.push({
      key: `c:${seed.key}`,
      spots: members,
      pins: members.flatMap((m) => m.pins),
      px: members.reduce((sum, m) => sum + m.px, 0) / members.length,
      py: members.reduce((sum, m) => sum + m.py, 0) / members.length,
    });
  }
  return out;
}

/** Round count badge for a zoom-out cluster, coloured like its most outstanding pin. */
function clusterIcon(pins: readonly MapPin[]) {
  const lead = pins.find((p) => p.discovered === false) ?? pins[0];
  const color = lead ? categoryColor(lead.category, lead.discovered) : PIN_COLOR.default;
  const n = pins.length;
  const size = n < 10 ? 30 : n < 50 ? 36 : 42;
  const label = n > 999 ? '999+' : n.toString();
  const key = `cluster:${color}:${size.toString()}:${label}`;
  const cached = pinIconCache.get(key);
  if (cached) return cached;
  const ic = divIcon({
    className: '',
    html:
      `<div style="width:${size.toString()}px;height:${size.toString()}px;border-radius:50%;` +
      `background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.6);` +
      `display:flex;align-items:center;justify-content:center;color:#fff;` +
      `font:700 ${size < 36 ? '11' : '12'}px system-ui,sans-serif;` +
      `text-shadow:0 1px 2px rgba(0,0,0,.6)">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
  pinIconCache.set(key, ic);
  return ic;
}

/** Cluster tooltip: "12 pins · 8 items · 3 graces · 1 boss · click to expand". */
function ClusterTooltipBody({ pins }: { pins: readonly MapPin[] }) {
  const counts = { item: 0, grace: 0, boss: 0 };
  for (const p of pins) if (p.kind in counts) counts[p.kind as keyof typeof counts]++;
  const parts = [
    counts.item > 0 && `${counts.item.toString()} item${counts.item === 1 ? '' : 's'}`,
    counts.grace > 0 && `${counts.grace.toString()} grace${counts.grace === 1 ? '' : 's'}`,
    counts.boss > 0 && `${counts.boss.toString()} boss${counts.boss === 1 ? '' : 'es'}`,
  ].filter(Boolean);
  return (
    <span>
      <strong>{pins.length} pins</strong>
      {parts.length > 0 && <span className='opacity-70'> · {parts.join(' · ')}</span>}
      <span className='opacity-70'> · click to expand</span>
    </span>
  );
}

/**
 * Pins — already in master-pixel space; unproject at native zoom → latlng.
 *
 * Two levels of grouping keep the map legible (and the marker count — the main render
 * cost — low when zoomed out):
 *   1. **Clusters**: spots within {@link CLUSTER_RADIUS_PX} screen pixels at the current
 *      zoom merge into one round count badge (at every zoom, max included). Clicking it
 *      zooms to fit its spots when that would separate them, else spreads it in place.
 *   2. **Same-spot stacks**: pins on one exact spot render as ONE numbered teardrop;
 *      clicking it spreads the stack into a grid (each pin individually hoverable /
 *      clickable), and any click on the map itself, or a zoom, collapses it. Marker
 *      clicks don't bubble to the map in Leaflet, so opening a spread pin's popup keeps
 *      the stack open.
 * Only pins of one {@link mergeGroup} ever merge. Markers outside the (padded) viewport
 * aren't rendered at all — item quick-selects can pin thousands of locations.
 */
function MarkerLayer({ pins, zoom }: { pins: MapPin[]; zoom: number }) {
  const map = useMap();
  const [mapZoom, setMapZoom] = useState(() => map.getZoom());
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Rendered area: the viewport plus a margin, refreshed after every pan/zoom.
  // Bumped whenever the visible area may have changed; the rendered area is read from the
  // map itself when it does. (Capturing bounds once at mount went stale: the map isn't
  // sized/fitted yet then, which left a first load with no markers until the first zoom.)
  const [viewTick, setViewTick] = useState(0);
  const bumpView = () => setViewTick((t) => t + 1);
  // Spread offsets are in screen pixels, so a zoom would distort the grid — collapse like
  // markercluster does; and re-cluster once the zoom settles.
  useMapEvents({
    click: () => setExpandedKey(null),
    zoomstart: () => setExpandedKey(null),
    zoomend: () => {
      setMapZoom(map.getZoom());
      bumpView();
    },
    moveend: bumpView,
    resize: bumpView,
    viewreset: bumpView,
  });
  useEffect(() => {
    // Once the map is ready and after the first paint (the initial fitBounds/resize).
    map.whenReady(bumpView);
    const raf = requestAnimationFrame(bumpView);
    return () => cancelAnimationFrame(raf);
  }, [map]);

  // Same-spot stacks, bucketed by merge group so clusters never mix kinds or found-states.
  // Keyed by group + location so an open popup / spread stack survives unrelated pin
  // changes.
  const spotsByGroup = useMemo(() => {
    const byGroup = new Map<string, Spot[]>();
    for (const [key, group] of groupByLocation(pins)) {
      const [pin] = group;
      if (!pin) continue;
      const spot: Spot = { key, pins: group, px: pin.px, py: pin.py };
      const g = mergeGroup(pin);
      const list = byGroup.get(g);
      if (list) list.push(spot);
      else byGroup.set(g, [spot]);
    }
    return [...byGroup.values()];
  }, [pins]);
  // `zoom` is the pins' native (master-pixel) zoom: 1 master px = 2^(mapZoom - zoom) screen px.
  // Clustering stays on at every zoom — pins closer than the radius merge even at max zoom,
  // where a cluster click spiderfies instead of zooming.
  const clusters = useMemo(
    () =>
      spotsByGroup.flatMap((spots) =>
        clusterSpots(spots, CLUSTER_RADIUS_PX / 2 ** (mapZoom - zoom)),
      ),
    [spotsByGroup, mapZoom, zoom],
  );
  const visibleClusters = useMemo(() => {
    // `viewTick` is the recompute trigger: the bounds are read from the map, not state.
    void viewTick;
    // An unsized container (hidden tab/pane, not laid out yet) has point-sized bounds that
    // would cull everything — render all until it has a real size.
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return clusters;
    const view = map.getBounds().pad(0.3);
    return clusters.filter(
      (c) => c.key === expandedKey || view.contains(map.unproject([c.px, c.py], zoom)),
    );
  }, [clusters, viewTick, expandedKey, map, zoom]);

  /** Spread `group` into a grid around `center` (see {@link spreadOffsets}). */
  const renderSpider = (key: string, center: LatLng, group: readonly MapPin[]) => {
    const hub = map.latLngToLayerPoint(center);
    const legs = spreadOffsets(group.length).map(([dx, dy]) =>
      map.layerPointToLatLng(hub.add([dx, dy])),
    );
    // Key spread pins by identity, not index: if the group changes while spread (a pickup
    // gets hidden, a layer toggles), an open popup must stay on ITS pin rather than being
    // reused for whichever pin now sits at that index.
    const seen = new Map<string, number>();
    const pinKeys = group.map((p) => {
      const base = `${p.kind}:${p.name}:${p.px.toString()}:${p.py.toString()}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return `${base}#${n.toString()}`;
    });
    return (
      <Fragment key={key}>
        {legs.map((leg, i) => (
          <Polyline
            key={`leg-${i.toString()}`}
            positions={[center, leg]}
            interactive={false}
            pathOptions={{ color: '#fff', weight: 1.5, opacity: 0.7 }}
          />
        ))}
        <Marker position={center} icon={spiderHubIcon} interactive={false} />
        {group.map((p, i) => {
          const leg = legs[i];
          return leg ? (
            <SinglePinMarker key={pinKeys[i]} pin={p} position={leg} zIndexOffset={1000} />
          ) : null;
        })}
      </Fragment>
    );
  };

  const renderSpot = ({ key, pins: group, px, py }: Spot) => {
    const [pin] = group;
    if (!pin) return null;
    const center = map.unproject([px, py], zoom);
    if (group.length === 1) return <SinglePinMarker key={key} pin={pin} position={center} />;
    if (expandedKey === key) return renderSpider(key, center, group);
    // (A spread stack is keyed by its spot; a spread cluster by its cluster key.)
    return (
      <Marker
        key={key}
        position={center}
        icon={stackIcon(group)}
        eventHandlers={{ click: () => setExpandedKey(key) }}
      >
        <Tooltip direction='top' offset={[0, -22]}>
          <PinGroupTooltipBody pins={group} />
        </Tooltip>
      </Marker>
    );
  };

  return (
    <>
      {visibleClusters.map((cluster) => {
        const [only] = cluster.spots;
        if (cluster.spots.length === 1 && only) return renderSpot(only);
        const center = map.unproject([cluster.px, cluster.py], zoom);
        if (expandedKey === cluster.key) return renderSpider(cluster.key, center, cluster.pins);
        return (
          <Marker
            key={cluster.key}
            position={center}
            icon={clusterIcon(cluster.pins)}
            eventHandlers={{
              click: () => {
                // Zoom in to separate the cluster when that helps; at max zoom (or when its
                // spots are too close for any zoom to split them) fan it out in place.
                const bounds = latLngBounds(
                  cluster.spots.map((s) => map.unproject([s.px, s.py], zoom)),
                );
                const target = Math.min(
                  map.getBoundsZoom(bounds, false, point(120, 120)),
                  map.getMaxZoom(),
                );
                // Would these spots still merge into one badge at `target`? Then zooming
                // can't separate them — spread right away instead of needing a 2nd click.
                const splitsAtTarget =
                  clusterSpots(cluster.spots, CLUSTER_RADIUS_PX / 2 ** (target - zoom)).length > 1;
                if (target > map.getZoom() + 0.01 && splitsAtTarget) {
                  map.fitBounds(bounds, { padding: [60, 60], maxZoom: map.getMaxZoom() });
                } else {
                  setExpandedKey(cluster.key);
                }
              },
            }}
          >
            <Tooltip direction='top' offset={[0, -16]}>
              <ClusterTooltipBody pins={cluster.pins} />
            </Tooltip>
          </Marker>
        );
      })}
    </>
  );
}

/**
 * Always-on status readout (bottom-right) — current zoom + the master-pixel the
 * map is centered on. Mirrors the readout the old prod map had; handy for getting
 * a feel for the projection and for reporting coordinates.
 */
function MapStatusReadout({ zoom }: { zoom: number }) {
  const map = useMap();
  const read = () => {
    const p = map.project(map.getCenter(), zoom);
    return {
      z: map.getZoom().toFixed(1),
      x: Math.round(p.x),
      y: Math.round(p.y),
    };
  };
  const [info, setInfo] = useState(read);
  useMapEvents({
    move: () => setInfo(read()),
    zoom: () => setInfo(read()),
  });
  return (
    <div className='leaflet-bottom leaflet-right'>
      <div className='leaflet-control rounded bg-black/70 px-2 py-1 font-mono text-[11px] text-white/90'>
        z {info.z} · {info.x}, {info.y}
      </div>
    </div>
  );
}

function MapBody({
  manifest,
  activeMapId,
  pins,
  playerPin,
  bloodstainPin,
  tileIndex,
  recenterToken,
}: {
  manifest: MapManifest;
  activeMapId: string;
  pins: MapPin[];
  playerPin?: MapPin | null;
  /** Last-death bloodstain ("lost runes"). `runes > 0` = active; `<= 0` = recovered. */
  bloodstainPin?: MapPin | null;
  tileIndex?: TileIndex;
  /** Bumped by the "Center on me" button — recenters on the player at close zoom. */
  recenterToken?: number;
}) {
  const map = useMap();
  const z = manifest.maxNativeZoom;

  // Existence lookup for the active map. No index (not loaded / fetch failed) →
  // allow every tile, i.e. fall back to the previous request-and-maybe-404 behavior.
  const exists = useMemo(() => {
    const perZoom = tileIndex?.[activeMapId];
    if (!perZoom) return () => true;
    const sets = new Map<number, Set<number>>();
    for (const [zoom, pairs] of Object.entries(perZoom)) {
      const set = new Set<number>();
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const x = pairs[i];
        const y = pairs[i + 1];
        if (x !== undefined && y !== undefined) set.add(tileKey(x, y));
      }
      sets.set(Number(zoom), set);
    }
    return (tz: number, tx: number, ty: number) => sets.get(tz)?.has(tileKey(tx, ty)) ?? false;
  }, [tileIndex, activeMapId]);

  // rastercoords getMaxBounds(): SW = unproject([0,h]), NE = unproject([w,0]).
  const bounds = useMemo(
    () =>
      latLngBounds(map.unproject([0, manifest.height], z), map.unproject([manifest.width, 0], z)),
    [map, manifest.height, manifest.width, z],
  );

  const [didInit, setDidInit] = useState(false);
  useEffect(() => {
    map.setMaxBounds(bounds);
    // Clamp zoom-out to "the whole map just fits" — you can pull back until the
    // entire map is visible, but no further (no zooming out into the black void).
    // Recompute on resize: when this first runs the container may be unsized, so
    // getBoundsZoom would return 0 (cap effectively gone) until the next resize.
    const applyMinZoom = () => {
      map.setMinZoom(map.getBoundsZoom(bounds));
    };
    applyMinZoom();
    map.on('resize', applyMinZoom);
    if (!didInit) {
      map.fitBounds(bounds);
      setDidInit(true);
    }
    return () => {
      map.off('resize', applyMinZoom);
    };
  }, [map, bounds, didInit]);

  // "Center on me" — fly to the player at a close, readable zoom. Guarded by a
  // ref so a save-poll that re-renders this component doesn't re-trigger a jump;
  // only an actual button press (a new token) recenters.
  const lastRecenter = useRef(0);
  useEffect(() => {
    if (!recenterToken || recenterToken === lastRecenter.current) return;
    lastRecenter.current = recenterToken;
    if (!playerPin || playerPin.master !== activeMapId) return;
    map.setView(map.unproject([playerPin.px, playerPin.py], z), z);
  });

  return (
    <>
      <ExistenceTileLayer
        key={activeMapId}
        url={`${MAP_TILES_BASE}/${activeMapId}/${BASE_LAYER}/{z}/{y}/{x}.webp`}
        tileSize={manifest.tileSize}
        maxNativeZoom={z}
        bounds={bounds}
        exists={exists}
      />
      <MarkerLayer pins={pins.filter((p) => p.master === activeMapId)} zoom={z} />
      {playerPin && playerPin.master === activeMapId && (
        <Marker position={map.unproject([playerPin.px, playerPin.py], z)} icon={playerIcon}>
          <Tooltip direction='top' offset={[0, -10]}>
            <PinTooltipBody pin={playerPin} />
          </Tooltip>
          <Popup>
            <PinPopupBody pin={playerPin} />
          </Popup>
        </Marker>
      )}
      {bloodstainPin && bloodstainPin.master === activeMapId && (
        // runes > 0 → active "lost runes"; otherwise the spot is retained but the
        // runes have already been recovered (or were never dropped). Text is built
        // in `useBloodstainPin`; here we only pick the active vs. recovered icon.
        <Marker
          position={map.unproject([bloodstainPin.px, bloodstainPin.py], z)}
          icon={(bloodstainPin.runes ?? 0) > 0 ? bloodstainIcon : bloodstainRecoveredIcon}
        >
          <Tooltip direction='top' offset={[0, -6]}>
            <PinTooltipBody pin={bloodstainPin} />
          </Tooltip>
          <Popup>
            <PinPopupBody pin={bloodstainPin} />
          </Popup>
        </Marker>
      )}
      <MapStatusReadout zoom={z} />
    </>
  );
}

export default function LeafletMap({
  manifest,
  activeMapId,
  pins,
  playerPin,
  bloodstainPin,
  tileIndex,
  recenterToken,
}: {
  manifest: MapManifest;
  activeMapId: string;
  pins: MapPin[];
  playerPin?: MapPin | null;
  bloodstainPin?: MapPin | null;
  tileIndex?: TileIndex;
  recenterToken?: number;
}) {
  return (
    <MapContainer
      crs={CRS.Simple}
      minZoom={0}
      maxZoom={manifest.maxNativeZoom + 2}
      // Finer zoom granularity — snap/step in 0.25 increments (default is 1.0).
      zoomSnap={0.25}
      zoomDelta={0.25}
      center={[0, 0]}
      zoom={2}
      attributionControl={false}
      style={{ height: '100%', width: '100%', background: '#0a0a0a' }}
    >
      <MapBody
        manifest={manifest}
        activeMapId={activeMapId}
        pins={pins}
        playerPin={playerPin}
        bloodstainPin={bloodstainPin}
        tileIndex={tileIndex}
        recenterToken={recenterToken}
      />
    </MapContainer>
  );
}
