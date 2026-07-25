/**
 * Glyph Atlas
 *
 * Caches rasterised glyphs in a single offscreen canvas so the renderer can
 * composite text with `drawImage` instead of calling `fillText` per cell.
 *
 * `fillText` runs font matching, shaping and rasterisation on every call. For
 * a terminal that repaints a full 80x40 viewport it is issued ~3200 times a
 * frame for what is usually a few dozen distinct glyphs. Rasterising each
 * distinct glyph once and blitting the result is roughly an order of magnitude
 * cheaper, and blank cells become free.
 *
 * ## Cache key
 *
 * A glyph is identified by its text, its fill colour and the bold/italic
 * flags. Background colour is deliberately not part of the key: glyphs are
 * rasterised onto transparency and composited over the cell background the
 * renderer has already painted, which is also what keeps the key space small
 * enough to be worth caching. Faint text is not keyed either — the renderer
 * applies it with `globalAlpha`, which `drawImage` honours identically.
 *
 * ## Geometry
 *
 * Everything inside the atlas is in device pixels and the atlas context is
 * left unscaled, so the font is set at `fontSize * devicePixelRatio`. That is
 * equivalent to a dpr-scaled context drawing at `fontSize`, and it keeps slot
 * boundaries on integer device pixels. Each entry records the offset from the
 * glyph's draw origin (pen x, baseline y) so the renderer can position the
 * blit without knowing how the glyph was packed.
 *
 * Slots are sized from the glyph's actual ink box rather than the cell box.
 * Terminal glyphs routinely spill outside their cell — italics overhang to the
 * right, combining marks in complex scripts extend left, powerline glyphs fill
 * the full cell height — and a cell-sized slot would clip them. Engines that
 * do not report `actualBoundingBox*` metrics fall back to a padded cell box.
 *
 * ## Capacity
 *
 * The atlas is packed with a simple shelf allocator. When it fills up it is
 * cleared and repacked, which costs one frame of re-rasterisation. If that
 * happens repeatedly the working set genuinely does not fit, so caching is
 * switched off and the renderer falls back to `fillText` — degrading to the
 * previous behaviour rather than thrashing.
 */

/** A rasterised glyph's location in the atlas and its draw offset. */
export interface AtlasGlyph {
  /** Source rect in the atlas bitmap, device pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /**
   * Offset from the glyph's draw origin to the top-left of the source rect,
   * in device pixels. The draw origin is (pen x, baseline y) — the same point
   * that would be passed to `fillText`.
   */
  dx: number;
  dy: number;
  /** True when the glyph has no ink and nothing needs to be blitted. */
  blank: boolean;
}

/** Builds a CSS font shorthand for a style prefix and a pixel size. */
export type FontStringBuilder = (style: string, sizePx: number) => string;

export interface GlyphAtlasOptions {
  devicePixelRatio: number;
  fontSize: number;
  buildFontString: FontStringBuilder;
  /** Cell width in CSS pixels, used to size the atlas and the fallback box. */
  cellWidth: number;
  /** Cell height in CSS pixels, used to size the atlas and the fallback box. */
  cellHeight: number;
  /** Distance from cell top to baseline in CSS pixels, for the fallback box. */
  baseline: number;
}

/** Glyphs the atlas aims to hold before it has to repack. */
const TARGET_GLYPHS = 512;

/** Bounds on the atlas edge length in device pixels. 2048 caps it at 16MB. */
const MIN_ATLAS_SIZE = 512;
const MAX_ATLAS_SIZE = 2048;

/** Repacks tolerated before caching is abandoned as counter-productive. */
const MAX_REPACKS = 4;

/** Slack added around each glyph so antialiasing cannot bleed across slots. */
const SLACK = 1;

function nextPowerOfTwo(n: number): number {
  let v = MIN_ATLAS_SIZE;
  while (v < n) v *= 2;
  return v;
}

export class GlyphAtlas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  /**
   * Glyphs bucketed by appearance, then by text.
   *
   * Two levels rather than one composite string key because the lookup runs
   * once per painted cell. Building a `${style}|${color}|${text}` key would
   * allocate a string per cell — thousands per frame — which measurably
   * outweighs what the cache saves. Terminal output arrives in runs that share
   * a colour and style, so the outer bucket is memoised below and the per-cell
   * cost collapses to one Map.get on the text.
   */
  private buckets = new Map<string, Map<string, AtlasGlyph>>();

  /** Memoised outer bucket, valid while colour and style are unchanged. */
  private lastColor: string | null = null;
  private lastStyleBits = -1;
  private lastBucket: Map<string, AtlasGlyph> | null = null;

  /** Shelf allocator cursor, device pixels. */
  private penX = 0;
  private shelfY = 0;
  private shelfHeight = 0;

  private size: number;
  private repacks = 0;
  private disabled = false;

  private dpr: number;
  private buildFontString: FontStringBuilder;
  private fontSizeDevice: number;

  /**
   * Conservative ink box in device pixels, used when the platform does not
   * report `actualBoundingBox*` from `measureText`. Padded by a full cell
   * horizontally and half a cell vertically so overhanging glyphs survive.
   */
  private fallbackBox: { left: number; right: number; ascent: number; descent: number };

  constructor(opts: GlyphAtlasOptions) {
    this.dpr = opts.devicePixelRatio;
    this.buildFontString = opts.buildFontString;
    this.fontSizeDevice = opts.fontSize * this.dpr;

    const cellW = opts.cellWidth * this.dpr;
    const cellH = opts.cellHeight * this.dpr;
    const ascent = opts.baseline * this.dpr;

    this.fallbackBox = {
      left: Math.ceil(cellW),
      right: Math.ceil(cellW * 2),
      ascent: Math.ceil(ascent + cellH * 0.5),
      descent: Math.ceil(cellH - ascent + cellH * 0.5),
    };

    // Size the atlas from the slot size so a large font or a high DPR still
    // gets room for a useful working set before it has to repack.
    const slotArea =
      (cellW + 2 * SLACK) * 2 * (cellH + 2 * SLACK) * 1.5 || MIN_ATLAS_SIZE * MIN_ATLAS_SIZE;
    const edge = Math.sqrt(slotArea * TARGET_GLYPHS);
    this.size = Math.min(MAX_ATLAS_SIZE, Math.max(MIN_ATLAS_SIZE, nextPowerOfTwo(edge)));

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size;
    this.canvas.height = this.size;

    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('GlyphAtlas: failed to get 2D context');
    this.ctx = ctx;
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';
  }

  /** The atlas bitmap, to be passed as the source image of `drawImage`. */
  public get bitmap(): HTMLCanvasElement {
    return this.canvas;
  }

  /** True once caching has been abandoned; callers must use `fillText`. */
  public get isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Look up a glyph, rasterising it on first use.
   *
   * Returns null when the glyph cannot be cached, in which case the caller
   * must fall back to `fillText`. That happens when the atlas has been
   * disabled after too many repacks, or when a single glyph is larger than
   * the whole atlas.
   */
  public get(text: string, color: string, bold: boolean, italic: boolean): AtlasGlyph | null {
    const styleBits = (bold ? 1 : 0) | (italic ? 2 : 0);

    // Reuse the previous bucket while the run's appearance is unchanged, which
    // is the common case and keeps this path free of allocation.
    const bucket =
      this.lastBucket !== null && this.lastStyleBits === styleBits && this.lastColor === color
        ? this.lastBucket
        : this.bucketFor(styleBits, color);

    const hit = bucket.get(text);
    if (hit !== undefined) return hit;
    if (this.disabled) return null;

    // A space is the most common cell in a terminal and never has ink.
    // Short-circuit it rather than trusting metrics to report an empty box.
    if (text === ' ') {
      const blank: AtlasGlyph = { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, blank: true };
      bucket.set(text, blank);
      return blank;
    }

    let style = '';
    if (italic) style += 'italic ';
    if (bold) style += 'bold ';
    const font = this.buildFontString(style, this.fontSizeDevice);

    this.ctx.font = font;
    const box = this.measureInk(text);
    if (box === null) {
      const blank: AtlasGlyph = { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, blank: true };
      bucket.set(text, blank);
      return blank;
    }

    const sw = box.left + box.right;
    const sh = box.ascent + box.descent;
    if (sw > this.size || sh > this.size) return null;

    const slot = this.allocate(sw, sh);
    if (slot === null) return null;

    // A repack inside allocate() resets the context state along with the
    // bitmap, so the font has to be reapplied before drawing.
    this.ctx.font = font;
    this.ctx.fillStyle = color;
    this.ctx.clearRect(slot.x, slot.y, sw, sh);
    this.ctx.fillText(text, slot.x + box.left, slot.y + box.ascent);

    const entry: AtlasGlyph = {
      sx: slot.x,
      sy: slot.y,
      sw,
      sh,
      dx: -box.left,
      dy: -box.ascent,
      blank: false,
    };
    // A repack inside allocate() empties the buckets, so re-resolve the target
    // rather than trusting the reference captured above.
    this.bucketFor(styleBits, color).set(text, entry);
    return entry;
  }

  /** Resolve (creating if needed) the bucket for an appearance, and memoise it. */
  private bucketFor(styleBits: number, color: string): Map<string, AtlasGlyph> {
    const bucketKey = `${styleBits} ${color}`;
    let found = this.buckets.get(bucketKey);
    if (found === undefined) {
      found = new Map<string, AtlasGlyph>();
      this.buckets.set(bucketKey, found);
    }
    this.lastBucket = found;
    this.lastColor = color;
    this.lastStyleBits = styleBits;
    return found;
  }

  /** Drop every cached glyph along with the memoised bucket. */
  private clearBuckets(): void {
    this.buckets.clear();
    this.lastBucket = null;
    this.lastColor = null;
    this.lastStyleBits = -1;
  }

  /**
   * Measure a glyph's ink box in device pixels, as positive distances from the
   * draw origin. Returns null when the glyph has no ink.
   *
   * `actualBoundingBoxLeft` is positive when ink extends left of the origin,
   * which is exactly the padding a left-extending combining mark needs.
   */
  private measureInk(
    text: string
  ): { left: number; right: number; ascent: number; descent: number } | null {
    const m = this.ctx.measureText(text);

    const hasInkMetrics =
      typeof m.actualBoundingBoxLeft === 'number' &&
      typeof m.actualBoundingBoxRight === 'number' &&
      typeof m.actualBoundingBoxAscent === 'number' &&
      typeof m.actualBoundingBoxDescent === 'number';

    if (!hasInkMetrics) {
      const f = this.fallbackBox;
      return { left: f.left, right: f.right, ascent: f.ascent, descent: f.descent };
    }

    const width = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const height = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    if (!(width > 0) || !(height > 0)) return null;

    return {
      left: Math.ceil(m.actualBoundingBoxLeft) + SLACK,
      right: Math.ceil(m.actualBoundingBoxRight) + SLACK,
      ascent: Math.ceil(m.actualBoundingBoxAscent) + SLACK,
      descent: Math.ceil(m.actualBoundingBoxDescent) + SLACK,
    };
  }

  /**
   * Reserve a slot with a shelf allocator: fill the current row left to
   * right, then start a new row at the tallest glyph seen so far.
   */
  private allocate(w: number, h: number): { x: number; y: number } | null {
    if (this.penX + w > this.size) {
      this.shelfY += this.shelfHeight;
      this.shelfHeight = 0;
      this.penX = 0;
    }

    if (this.shelfY + h > this.size) {
      if (!this.repack()) return null;
    }

    const slot = { x: this.penX, y: this.shelfY };
    this.penX += w;
    this.shelfHeight = Math.max(this.shelfHeight, h);
    return slot;
  }

  /**
   * Clear the atlas and start packing from scratch. Entries already composited
   * onto the terminal canvas are unaffected — they were blitted before this
   * point — so discarding them is safe, it just costs re-rasterisation.
   *
   * Returns false once the repack budget is spent, which disables caching for
   * good. A working set that never fits would otherwise repack every frame and
   * end up slower than plain `fillText`.
   */
  private repack(): boolean {
    if (this.repacks >= MAX_REPACKS) {
      this.disabled = true;
      this.clearBuckets();
      return false;
    }

    this.repacks++;
    this.clearBuckets();
    this.penX = 0;
    this.shelfY = 0;
    this.shelfHeight = 0;
    this.ctx.clearRect(0, 0, this.size, this.size);
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';
    return true;
  }

  /** Release the backing bitmap. */
  public dispose(): void {
    this.clearBuckets();
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
