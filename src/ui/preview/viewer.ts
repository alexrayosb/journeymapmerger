/**
 * Canvas map viewer: one dimension layer at a time, drag to pan, wheel to
 * zoom around the cursor, waypoint markers with the name on hover.
 * Block coordinates: x to the right, z down, like JourneyMap.
 */
import { TILE_BLOCKS, tileKey, type LayerTiles, type Waypoint } from '../../merge/tiles.ts';
import { waypointInDim, waypointMapPosition } from '../../merge/tiles.ts';
import type { EntryInfo } from '../../merge/types.ts';
import { el } from '../dom.ts';
import { THUMB_SIZE, TileCache, type TileSource } from './tile-cache.ts';

const MIN_SCALE = 1 / 256; // px per block: a tile is 2 px
const MAX_SCALE = 16;
const MARKER_RADIUS = 5;

interface Marker {
  readonly wp: Waypoint;
  readonly x: number;
  readonly z: number;
}

export class MapViewer<E extends EntryInfo = EntryInfo> {
  readonly element: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private readonly label: HTMLSpanElement;
  private readonly coords: HTMLSpanElement;
  private readonly ctx: CanvasRenderingContext2D;
  private cache: TileCache | null = null;
  private layer: LayerTiles<E> | null = null;
  private markers: Marker[] = [];
  private hovered: Marker | null = null;
  private view = { cx: 0, cz: 0, scale: 0.25 };
  private frame = 0;
  private dragging: { x: number; y: number; cx: number; cz: number } | null = null;
  private readonly observer: ResizeObserver;

  constructor(coords: HTMLSpanElement) {
    this.coords = coords;
    this.canvas = el('canvas', { className: 'map-canvas', testId: 'map-canvas' });
    this.label = el('span', { className: 'wp-label', hidden: true, testId: 'wp-label' });
    this.element = el('div', { className: 'viewer', testId: 'viewer' }, [this.canvas, this.label]);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;

    this.observer = new ResizeObserver(() => {
      this.resize();
    });
    this.observer.observe(this.element);

    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.dragging = { x: e.clientX, y: e.clientY, cx: this.view.cx, cz: this.view.cz };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        this.view.cx = this.dragging.cx - (e.clientX - this.dragging.x) / this.view.scale;
        this.view.cz = this.dragging.cz - (e.clientY - this.dragging.y) / this.view.scale;
        this.schedule();
      } else {
        this.updateHover(e);
      }
      const rect = this.canvas.getBoundingClientRect();
      const { x, z } = this.toBlock(e.clientX - rect.left, e.clientY - rect.top);
      this.coords.textContent = `x ${String(Math.floor(x))}, z ${String(Math.floor(z))}`;
    });
    const endDrag = (e: PointerEvent): void => {
      if (this.dragging && this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      this.dragging = null;
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('pointerleave', () => {
      this.coords.textContent = '';
      this.setHover(null);
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false },
    );
  }

  /** Show a layer. The source resolves a tile key to PNG bytes. */
  setLayer(layer: LayerTiles<E> | null, source: TileSource, waypoints: readonly Waypoint[]): void {
    this.cache?.dispose();
    this.cache = new TileCache(source, () => {
      this.canvas.dataset['tilesLoaded'] = String(this.cache?.loaded ?? 0);
      this.schedule();
    });
    this.layer = layer;
    this.markers = layer
      ? waypoints
          .filter((wp) => wp.enabled && waypointInDim(wp, layer.dim))
          .map((wp) => ({ wp, ...waypointMapPosition(wp, layer.dim) }))
      : [];
    this.canvas.dataset['tilesLoaded'] = '0';
    this.setHover(null);
    this.fit();
  }

  /** Zoom so the whole layer is visible. */
  fit(): void {
    if (!this.layer) return;
    const { minX, maxX, minZ, maxZ } = this.layer.bounds;
    const widthBlocks = (maxX - minX + 1) * TILE_BLOCKS;
    const heightBlocks = (maxZ - minZ + 1) * TILE_BLOCKS;
    const { width, height } = this.size();
    const scale = Math.min(width / widthBlocks, height / heightBlocks) * 0.95;
    this.view = {
      cx: (minX * TILE_BLOCKS + (maxX + 1) * TILE_BLOCKS) / 2,
      cz: (minZ * TILE_BLOCKS + (maxZ + 1) * TILE_BLOCKS) / 2,
      scale: clamp(scale, MIN_SCALE, MAX_SCALE),
    };
    this.schedule();
  }

  zoomBy(factor: number): void {
    const { width, height } = this.size();
    this.zoomAt(factor, width / 2, height / 2);
  }

  dispose(): void {
    this.observer.disconnect();
    this.cache?.dispose();
    cancelAnimationFrame(this.frame);
  }

  private zoomAt(factor: number, px: number, py: number): void {
    const before = this.toBlock(px, py);
    this.view.scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    const after = this.toBlock(px, py);
    this.view.cx += before.x - after.x;
    this.view.cz += before.z - after.z;
    this.schedule();
  }

  private size(): { width: number; height: number } {
    return { width: this.element.clientWidth || 800, height: this.element.clientHeight || 500 };
  }

  private toBlock(px: number, py: number): { x: number; z: number } {
    const { width, height } = this.size();
    return {
      x: this.view.cx + (px - width / 2) / this.view.scale,
      z: this.view.cz + (py - height / 2) / this.view.scale,
    };
  }

  private toScreen(x: number, z: number): { px: number; py: number } {
    const { width, height } = this.size();
    return {
      px: (x - this.view.cx) * this.view.scale + width / 2,
      py: (z - this.view.cz) * this.view.scale + height / 2,
    };
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.size();
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const { ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.size();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(this.element).backgroundColor || '#111';
    ctx.fillRect(0, 0, width, height);
    this.canvas.dataset['scale'] = this.view.scale.toPrecision(4);
    if (!this.layer || !this.cache) return;

    const { scale } = this.view;
    const tilePx = TILE_BLOCKS * scale;
    const preferThumb = tilePx <= THUMB_SIZE;
    ctx.imageSmoothingEnabled = scale < 1;
    const topLeft = this.toBlock(0, 0);
    const bottomRight = this.toBlock(width, height);
    const rx0 = Math.floor(topLeft.x / TILE_BLOCKS);
    const rx1 = Math.floor(bottomRight.x / TILE_BLOCKS);
    const rz0 = Math.floor(topLeft.z / TILE_BLOCKS);
    const rz1 = Math.floor(bottomRight.z / TILE_BLOCKS);
    const { bounds, tiles } = this.layer;
    const wanted: { key: string; d: number }[] = [];
    const ccx = (rx0 + rx1) / 2;
    const ccz = (rz0 + rz1) / 2;

    for (let rz = Math.max(rz0, bounds.minZ); rz <= Math.min(rz1, bounds.maxZ); rz++) {
      for (let rx = Math.max(rx0, bounds.minX); rx <= Math.min(rx1, bounds.maxX); rx++) {
        const key = tileKey(rx, rz);
        if (!tiles.has(key)) continue;
        const bitmap = this.cache.get(key, preferThumb);
        const { px, py } = this.toScreen(rx * TILE_BLOCKS, rz * TILE_BLOCKS);
        if (bitmap) ctx.drawImage(bitmap, px, py, tilePx, tilePx);
        if (!this.cache.has(key, !preferThumb)) {
          wanted.push({ key, d: (rx - ccx) ** 2 + (rz - ccz) ** 2 });
        }
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    this.cache.want(wanted.map((w) => w.key));

    for (const m of this.markers) {
      const { px, py } = this.toScreen(m.x, m.z);
      if (px < -20 || py < -20 || px > width + 20 || py > height + 20) continue;
      const [r, g, b] = m.wp.color;
      ctx.beginPath();
      ctx.arc(px, py, m === this.hovered ? MARKER_RADIUS + 2 : MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
  }

  private updateHover(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best: Marker | null = null;
    let bestD = (MARKER_RADIUS + 4) ** 2;
    for (const m of this.markers) {
      const s = this.toScreen(m.x, m.z);
      const d = (s.px - px) ** 2 + (s.py - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    this.setHover(best);
  }

  private setHover(marker: Marker | null): void {
    if (marker === this.hovered) return;
    this.hovered = marker;
    if (marker) {
      const { px, py } = this.toScreen(marker.x, marker.z);
      this.label.textContent = `${marker.wp.name} (${String(Math.round(marker.wp.x))}, ${String(Math.round(marker.wp.y))}, ${String(Math.round(marker.wp.z))})`;
      this.label.style.left = `${String(px + 10)}px`;
      this.label.style.top = `${String(py - 10)}px`;
      this.label.hidden = false;
      this.canvas.style.cursor = 'pointer';
    } else {
      this.label.hidden = true;
      this.canvas.style.cursor = '';
    }
    this.schedule();
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
