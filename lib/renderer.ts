/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import { GlyphAtlas } from './glyph-atlas';
import type { ITheme } from './interfaces';
import { KITTY_PLACEHOLDER, diacriticToInt } from './kitty_diacritics';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, ILink, KittyImagePixels, KittyPlacementInfo } from './types';
import { CellFlags, KittyImageFormat } from './types';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  /**
   * Fetch every screen row in one pass. Optional: implementations that lack
   * it fall back to per-row getLine calls.
   *
   * Strongly preferred when present. getLine() on the WASM terminal walks the
   * whole viewport to return one row, so a renderer calling it per row costs
   * O(rows^2 * cols) WASM crossings per frame.
   */
  getViewportLines?(): (GhosttyCell[] | null)[];
  getCursor(): { x: number; y: number; visible: boolean; style?: 'block' | 'underline' | 'bar' };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;

  // Kitty graphics — optional. When implemented, the renderer composites
  // images onto the canvas after text rendering. GhosttyTerminal provides
  // these; other IRenderable implementations (e.g. test fakes) can omit.
  getKittyGraphics?(): number | null;
  iterPlacements?(graphics: number, onlyVisible?: boolean): Iterable<KittyPlacementInfo>;
  getKittyImagePixels?(graphics: number, imageId: number): KittyImagePixels | null;
  /**
   * Returns the full codepoint sequence for the cell at (row, col) in
   * the active screen — the base codepoint followed by any combining
   * marks. Used to decode unicode-placeholder cells (U+10EEEE plus
   * combining diacritics that encode row/column slice positions).
   */
  getGrapheme?(row: number, col: number): number[] | null;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  /**
   * Bulk read of a contiguous run. Strongly preferred when present: each
   * single-row read re-allocates WASM scratch and re-fetches the palette, and
   * a frame showing scrollback needs a run of adjacent rows.
   */
  getScrollbackLines?(startOffset: number, count: number): (GhosttyCell[] | null)[];
  getScrollbackLength(): number;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
  /**
   * Cache rasterised glyphs and composite them with drawImage instead of
   * calling fillText per cell. Default: true. Turn off to isolate the atlas
   * when chasing a rendering artefact.
   */
  glyphAtlas?: boolean;
  /**
   * Move already-correct pixels with a single blit when the viewport scrolls,
   * repainting only newly exposed rows. Default: true.
   */
  scrollBlit?: boolean;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels (multiple of 1/devicePixelRatio)
  height: number; // Character cell height in CSS pixels (multiple of 1/devicePixelRatio)
  baseline: number; // Distance from top to text baseline in CSS pixels
}

// ============================================================================
// Scrollbar layout
// ============================================================================

// Width (CSS px) of the gutter reserved on the right edge of the canvas for
// the scrollback scrollbar. The text grid is laid out across `cols *
// metrics.width` and the canvas is made this much wider so the scrollbar
// (drawn by renderScrollbar) sits beside the text instead of on top of it.
// Must be >= the scrollbar's drawn footprint (8px bar + 4px right pad + 2px
// left clear = 14px) and should match FitAddon's DEFAULT_SCROLLBAR_WIDTH so
// the reserved columns line up with the reserved pixels.
export const SCROLLBAR_GUTTER = 15;

// ============================================================================
// Default Theme
// ============================================================================

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  // Thumb is a subtle neutral grey by default. The track is empty by default
  // (matches VS Code, whose scrollbars have no visible track): the gutter just
  // shows the terminal background. Set scrollbarTrack to draw a channel.
  scrollbarThumb: 'rgba(128, 128, 128, 0.5)',
  scrollbarTrack: '',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

// ============================================================================
// CanvasRenderer Class
// ============================================================================

/**
 * Staleness check for kittyImageCache: an entry is reusable iff every
 * identity field matches the just-fetched KittyImagePixels. Width/height/
 * format catch geometry/format changes (which can keep dataLen identical —
 * e.g., 100×50 RGBA and 50×100 RGBA both serialize to 20000 bytes), and
 * dataPtr (the WASM byteOffset) catches re-allocations from retransmits.
 */
function cachedMatchesPixels(
  cached: {
    width: number;
    height: number;
    format: KittyImageFormat;
    dataPtr: number;
    dataLen: number;
  },
  pixels: KittyImagePixels
): boolean {
  return (
    cached.width === pixels.width &&
    cached.height === pixels.height &&
    cached.format === pixels.format &&
    cached.dataPtr === pixels.data.byteOffset &&
    cached.dataLen === pixels.data.length
  );
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private devicePixelRatio: number;
  private metrics: FontMetrics;
  private palette: string[];

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };

  // Hook called whenever the renderer's own internal state (today: cursor
  // blink toggle) changes such that the next frame would look different.
  // Set by Terminal so it can wake its render scheduler. Without this, an
  // event-driven Terminal that has gone idle would never repaint the
  // blinking cursor.
  private onRequestRender: (() => void) | null = null;

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // ==========================================================================
  // Glyph atlas
  // ==========================================================================

  private glyphAtlasEnabled: boolean;
  /**
   * Created lazily on first render because it needs measured font metrics,
   * and dropped whenever the font, DPR or metrics change. Null means "not
   * built yet or invalidated"; a disabled atlas stays in place and reports
   * itself via isDisabled so we stop asking it for glyphs.
   */
  private glyphAtlas: GlyphAtlas | null = null;

  // ==========================================================================
  // Scroll blit
  // ==========================================================================

  private scrollBlitEnabled: boolean;

  /**
   * Staging bitmap for the scroll blit, used only when theme.background is
   * translucent. There the moved rows have to *replace* the destination band
   * rather than composite over it, and clearing the destination first would
   * destroy the source where the two bands overlap. An opaque background needs
   * none of this and moves pixels in a single self-copy, so this stays null in
   * the common case. Allocated on first use.
   */
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;

  /** Cached alpha test on theme.background. Null until first probed. */
  private backgroundOpaque: boolean | null = null;

  /**
   * Per-row content hashes describing *what is currently on the canvas*, as two
   * independent 32-bit hashes plus a validity flag per row.
   *
   * Used to verify a candidate scroll shift before trusting it: a row whose
   * hash matches its shifted predecessor is already correct once the pixels
   * move, and a row that mismatches gets repainted.
   *
   * Two hashes rather than one because a collision means skipping a repaint
   * that was needed, which shows as corrupt output. 64 bits makes that
   * vanishingly unlikely.
   *
   * The invariant that matters: canvasHash[y] must describe the pixels on row
   * y. Every repaint updates it, every blit shifts it, and anything that
   * invalidates the bitmap wholesale clears the validity flags. Rows flagged
   * invalid can never be retained by a blit.
   */
  private canvasHashA: Int32Array | null = null;
  private canvasHashB: Int32Array | null = null;
  private canvasHashValid: Uint8Array | null = null;

  /** Current-frame hashes, compared against the canvas hashes to verify a blit. */
  private frameHashA: Int32Array | null = null;
  private frameHashB: Int32Array | null = null;

  /**
   * Rows containing multi-codepoint grapheme clusters. Their hash only covers
   * the base codepoint and the cluster length, so two different clusters
   * sharing both would hash alike. Cheaper to always repaint these rows than to
   * resolve every cluster to a string for hashing.
   */
  private complexRows = new Set<number>();

  /** Inputs to the scroll-shift calculation, from the frame on the canvas. */
  private lastFlooredViewportY: number = 0;
  private lastScrollbackLength: number = 0;
  private lastDims: { cols: number; rows: number } | null = null;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  /**
   * Decoded kitty graphics images, keyed by image id. Each entry caches
   * a canvas painted from the WASM-side RGBA bytes so per-frame compositing
   * is just a drawImage call.
   *
   * Staleness key combines width/height/format/dataPtr/dataLen — the
   * kitty protocol allows reusing an id with new bytes, and dataLen alone
   * is too weak (transposed dims or format change can keep byte count
   * identical). dataPtr is the WASM byteOffset, which changes whenever
   * ghostty frees + re-allocates the image bytes (i.e., on retransmit).
   */
  private kittyImageCache = new Map<
    number,
    {
      canvas: HTMLCanvasElement;
      width: number;
      height: number;
      format: KittyImageFormat;
      dataPtr: number;
      dataLen: number;
    }
  >();

  /**
   * Per-frame index of virtual placements keyed by image id. Populated
   * once at the start of each render() pass (cheap — typically zero or
   * a handful of entries). Looked up by U+10EEEE placeholder cells in
   * renderPlaceholderCell to find the placement's grid dimensions.
   */
  private kittyVirtualPlacements = new Map<number, KittyPlacementInfo>();

  /**
   * Direct (non-virtual) placements that need compositing this frame.
   * Built once per render() in precomputeKittyState so renderKittyImages
   * doesn't re-walk the iterator. Empty when no kitty graphics are active.
   */
  private currentDirectPlacements: KittyPlacementInfo[] = [];

  /**
   * Last frame's direct-placement signatures, keyed by image id. Used to
   * detect placement add/remove/move/redecode so we can mark the affected
   * rows for repaint (clearing stale image pixels) and skip the composite
   * pass entirely when nothing has changed. dataLen is the same staleness
   * discriminator used by kittyImageCache.
   */
  private lastKittyDirectSigs = new Map<
    number,
    {
      viewportCol: number;
      viewportRow: number;
      pixelWidth: number;
      pixelHeight: number;
      sourceX: number;
      sourceY: number;
      sourceWidth: number;
      sourceHeight: number;
      imgWidth: number;
      imgHeight: number;
      imgFormat: KittyImageFormat;
      dataPtr: number;
      dataLen: number;
    }
  >();

  /**
   * Rows whose image footprint changed since last frame (placement added,
   * removed, moved, resized, or re-decoded under the same id). Added to
   * rowsToRender so the underlying text repaints — which clears stale
   * image pixels — before we composite the current placements on top.
   */
  private kittyDamagedRows = new Set<number>();

  /**
   * Cached IRenderable on the current render() call so renderCellText
   * can call into it (e.g. getGrapheme) without us threading the buffer
   * through every helper. Set at the top of render(), cleared at the end.
   */
  private currentRenderBuffer: IRenderable | null = null;
  private currentKittyGraphics: number | null = null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;
  // Same coordinates as of the previous rendered frame, so a frame can repaint
  // just the rows whose selection appearance changed.
  private previousSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    this.glyphAtlasEnabled = options.glyphAtlas ?? true;
    this.scrollBlitEnabled = options.scrollBlit ?? true;

    // Build color palette (16 ANSI colors)
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    if (this.cursorBlink) {
      this.startCursorBlink();
    }
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  /**
   * Build a CSS font string with proper quoting for font families with spaces.
   * Example: "Fira Code, monospace" -> '"Fira Code", monospace'
   *
   * `sizePx` defaults to the configured font size. The glyph atlas overrides
   * it with the device-pixel size because its context is left unscaled.
   */
  private buildFontString(style: string = '', sizePx: number = this.fontSize): string {
    // Quote font family names that contain spaces but aren't already quoted
    const quotedFamily = this.fontFamily
      .split(',')
      .map((f) => {
        const trimmed = f.trim();
        // Already quoted or a generic family (no spaces)
        if (trimmed.startsWith('"') || trimmed.startsWith("'") || !trimmed.includes(' ')) {
          return trimmed;
        }
        // Quote it
        return `"${trimmed}"`;
      })
      .join(', ');

    return `${style}${sizePx}px ${quotedFamily}`;
  }

  // ==========================================================================
  // Glyph Atlas
  // ==========================================================================

  /**
   * Drop the cached atlas. Called whenever the font, metrics or DPR change —
   * every entry was rasterised against the old values.
   *
   * Not needed on a theme change: colour is part of the cache key, so stale
   * entries are simply never looked up again. They cost atlas space until the
   * next repack, which is cheaper than discarding glyphs that are still live.
   */
  private invalidateGlyphAtlas(): void {
    this.glyphAtlas?.dispose();
    this.glyphAtlas = null;
  }

  /**
   * Toggle glyph caching at runtime so it can be A/B'd against fillText on a
   * live terminal. Disabling drops the atlas rather than leaving it allocated;
   * re-enabling rebuilds it lazily on the next cell that needs it.
   *
   * Note this cannot revive an atlas that disabled itself after repeated
   * repacks, or one that never had an offscreen context to build in. Those
   * clear glyphAtlasEnabled, and setting it back to true will simply fail the
   * same way on the next attempt.
   */
  public setGlyphAtlas(enabled: boolean): void {
    if (this.glyphAtlasEnabled === enabled) return;
    this.glyphAtlasEnabled = enabled;
    if (!enabled) this.invalidateGlyphAtlas();
  }

  /** Toggle scroll blitting at runtime. Off means every frame is a repaint. */
  public setScrollBlit(enabled: boolean): void {
    this.scrollBlitEnabled = enabled;
  }

  /**
   * The atlas for the current font, building it on first use. Returns null when
   * atlas rendering is off or the atlas has given up on caching, in which case
   * callers draw text with fillText.
   */
  private getGlyphAtlas(): GlyphAtlas | null {
    if (!this.glyphAtlasEnabled) return null;

    if (this.glyphAtlas === null) {
      try {
        this.glyphAtlas = new GlyphAtlas({
          devicePixelRatio: this.devicePixelRatio,
          fontSize: this.fontSize,
          buildFontString: (style, sizePx) => this.buildFontString(style, sizePx),
          cellWidth: this.metrics.width,
          cellHeight: this.metrics.height,
          baseline: this.metrics.baseline,
        });
      } catch {
        // No offscreen 2D context available. Fall back to fillText for the
        // rest of this renderer's life rather than retrying every frame.
        this.glyphAtlasEnabled = false;
        return null;
      }
    }

    return this.glyphAtlas.isDisabled ? null : this.glyphAtlas;
  }

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = this.buildFontString();

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');

    // Use font-level metrics (fontBoundingBox) rather than glyph-specific metrics.
    // This ensures cells accommodate ALL glyphs including powerline chars (U+E0B0-U+E0BF)
    // which are designed to fill the full cell height. Fall back to actual metrics.
    const ascent =
      widthMetrics.fontBoundingBoxAscent ||
      widthMetrics.actualBoundingBoxAscent ||
      this.fontSize * 0.8;
    const descent =
      widthMetrics.fontBoundingBoxDescent ||
      widthMetrics.actualBoundingBoxDescent ||
      this.fontSize * 0.2;

    // Round to device pixels so cell boundaries fall on exact physical pixels at any DPR.
    // Non-integer DPR values (1.25, 1.5, 1.75) otherwise produce fractional coordinates
    // at cell edges, causing the canvas rasteriser to antialias clearRect/fillRect edges
    // and create thin seams between cells on alpha:true canvases.
    const dpr = this.devicePixelRatio;
    const width = Math.ceil(widthMetrics.width * dpr) / dpr;
    const height = Math.ceil((ascent + descent) * dpr) / dpr;
    const baseline = Math.ceil(ascent * dpr) / dpr;

    return { width, height, baseline };
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
    this.invalidateGlyphAtlas();
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    // Text occupies `cols * metrics.width`; the canvas is widened by
    // SCROLLBAR_GUTTER so the scrollbar has its own space on the right and
    // never paints over the last columns of text.
    const cssWidth = cols * this.metrics.width + SCROLLBAR_GUTTER;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = cssWidth * this.devicePixelRatio;
    this.canvas.height = cssHeight * this.devicePixelRatio;

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Resizing clears the bitmap, so the row hashes no longer describe what is
    // on screen and the next frame must not blit against them.
    this.invalidateScrollBlitState();

    // Keep the blit scratch in step with the canvas it stages pixels for.
    if (this.scratchCanvas) {
      this.scratchCanvas.width = this.canvas.width;
      this.scratchCanvas.height = this.canvas.height;
    }

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  // ==========================================================================
  // Scroll Blit
  //
  // Scrolling moves every row's content to a new row, which marks the whole
  // viewport dirty and forces a full re-rasterisation. The pixels are almost
  // all still correct though — they just belong somewhere else on the canvas.
  // Moving them with one drawImage and repainting only the newly exposed rows
  // turns an O(rows * cols) glyph pass into a single bitmap copy.
  //
  // The shift is derived rather than reported. Row y always displays absolute
  // line `scrollbackLength - viewportY + y`, whether that line lives in
  // scrollback or on screen. Holding the absolute line fixed across two frames
  // and solving for the row it moved to gives:
  //
  //   shift = (viewportY - lastViewportY) - (scrollbackLength - lastLength)
  //
  // Positive shift moves content down the screen. Scrolling back through
  // history raises viewportY and shifts down; output streaming at the bottom
  // grows scrollback and shifts up. One formula covers both.
  //
  // The result is treated as a hypothesis, not a fact. Alternate-screen
  // programs and scrolling regions move content without growing scrollback, so
  // every retained row is hash-checked against its predecessor before its
  // pixels are reused, and mismatches are repainted.
  // ==========================================================================

  /**
   * Forget what is on the canvas, so the next frame draws in full instead of
   * blitting. Required whenever the bitmap stops matching the recorded hashes.
   */
  private invalidateScrollBlitState(): void {
    this.canvasHashValid?.fill(0);
  }

  /** Grow the hash buffers to `rows`, clearing validity if the size changed. */
  private ensureHashBuffers(rows: number): void {
    if (this.canvasHashValid !== null && this.canvasHashValid.length === rows) return;

    this.canvasHashA = new Int32Array(rows);
    this.canvasHashB = new Int32Array(rows);
    this.canvasHashValid = new Uint8Array(rows);
    this.frameHashA = new Int32Array(rows);
    this.frameHashB = new Int32Array(rows);
  }

  /**
   * Hash one row's rendered inputs into `a`/`b` at index `y`.
   *
   * The hash has to cover everything renderCellBackground and renderCellText
   * read off a cell, or a change would slip through as a skipped repaint.
   * Selection, hover and image state are excluded on purpose — a blit is only
   * attempted when none of them are active.
   *
   * Returns true when the row holds a grapheme cluster, which the caller must
   * treat as always-repaint: the hash sees only the base codepoint and the
   * cluster length, so two distinct clusters sharing both would hash alike.
   */
  private hashRowInto(
    line: GhosttyCell[] | null,
    y: number,
    a: Int32Array,
    b: Int32Array
  ): boolean {
    // Two FNV-1a streams with different offset bases, mixed with different
    // primes so they fail independently.
    let ha = 0x811c9dc5;
    let hb = 0x01000193;
    let complex = false;

    if (line !== null) {
      for (let x = 0; x < line.length; x++) {
        const cell = line[x];

        // Pack the flag-ish fields and the colours into single words so each
        // cell costs a handful of mixes rather than one per field.
        const attrs =
          cell.flags |
          (cell.fgIsDefault ? 1 << 24 : 0) |
          (cell.bgIsDefault ? 1 << 25 : 0) |
          (cell.width << 26);
        const fg = (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
        const bg = (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;

        ha = Math.imul(ha ^ cell.codepoint, 0x01000193);
        hb = Math.imul(hb ^ cell.codepoint, 0x85ebca6b);
        ha = Math.imul(ha ^ fg, 0x01000193);
        hb = Math.imul(hb ^ bg, 0x85ebca6b);
        ha = Math.imul(ha ^ bg, 0x01000193);
        hb = Math.imul(hb ^ fg, 0x85ebca6b);
        ha = Math.imul(ha ^ attrs, 0x01000193);
        hb = Math.imul(hb ^ (attrs + cell.grapheme_len), 0x85ebca6b);
        ha = Math.imul(ha ^ cell.hyperlink_id, 0x01000193);
        hb = Math.imul(hb ^ cell.hyperlink_id, 0x85ebca6b);

        if (cell.grapheme_len > 0) complex = true;
      }
    }

    // Fold in which columns of this row are selected.
    //
    // The blit moves pixels that already have the selection highlight painted
    // into them, so a row whose highlighted span changed must not be retained
    // even when its text is byte-identical. Hashing the span is what makes it
    // safe for the blit to run while a selection exists at all — without it
    // the only safe option was to disable the blit whenever anything was
    // selected, which meant every frame of a drag repainted the whole
    // viewport.
    const sel = this.currentSelectionCoords;
    let selStart = -1;
    let selEnd = -1;
    if (sel && y >= sel.startRow && y <= sel.endRow) {
      selStart = y === sel.startRow ? sel.startCol : 0;
      selEnd = y === sel.endRow ? sel.endCol : (line ? line.length - 1 : 0);
    }
    ha = Math.imul(ha ^ (selStart + 1), 0x01000193);
    hb = Math.imul(hb ^ (selEnd + 1), 0x85ebca6b);

    a[y] = ha | 0;
    b[y] = hb | 0;
    return complex;
  }

  /** Record that row `y` now shows the content hashed into the frame buffers. */
  private commitRowHash(y: number): void {
    const fa = this.frameHashA;
    const fb = this.frameHashB;
    const ca = this.canvasHashA;
    const cb = this.canvasHashB;
    const valid = this.canvasHashValid;
    if (!fa || !fb || !ca || !cb || !valid) return;

    ca[y] = fa[y];
    cb[y] = fb[y];
    valid[y] = 1;
  }

  /** Lazily created staging bitmap for the blit. Null if unavailable. */
  private getScratchCtx(): CanvasRenderingContext2D | null {
    if (this.scratchCtx) return this.scratchCtx;

    const canvas = document.createElement('canvas');
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return null;

    this.scratchCanvas = canvas;
    this.scratchCtx = ctx;
    return ctx;
  }

  /**
   * Shift the recorded canvas hashes to follow a blit of `shift` rows.
   *
   * Rows shifted in from off-screen have no pixels behind them yet, so their
   * validity is cleared — the caller repaints them as newly exposed rows.
   */
  private shiftCanvasHashes(shift: number, rows: number): void {
    const a = this.canvasHashA;
    const b = this.canvasHashB;
    const valid = this.canvasHashValid;
    if (!a || !b || !valid) return;

    if (shift > 0) {
      // Content moved down: walk from the bottom so we never overwrite a
      // source entry before reading it.
      for (let y = rows - 1; y >= shift; y--) {
        a[y] = a[y - shift];
        b[y] = b[y - shift];
        valid[y] = valid[y - shift];
      }
      for (let y = 0; y < shift; y++) valid[y] = 0;
    } else {
      const up = -shift;
      for (let y = 0; y < rows - up; y++) {
        a[y] = a[y + up];
        b[y] = b[y + up];
        valid[y] = valid[y + up];
      }
      for (let y = rows - up; y < rows; y++) valid[y] = 0;
    }
  }

  /**
   * Move the text area down by `shift` rows (negative moves up).
   *
   * Staged through a scratch bitmap so the copy replaces the destination band
   * instead of compositing over it, which matters when theme.background is
   * translucent. Source and destination are the same size and land on integer
   * device pixels, so nothing is resampled.
   *
   * Returns false when the scratch bitmap is unavailable, leaving the canvas
   * untouched so the caller can fall back to a full repaint.
   */
  private blitRows(shift: number, cols: number, rows: number): boolean {
    const dpr = this.devicePixelRatio;
    const rowHeight = this.metrics.height * dpr;
    const moved = rows - Math.abs(shift);
    if (moved <= 0) return false;

    // Only the text grid moves. The scrollbar gutter is redrawn every frame.
    const width = Math.round(cols * this.metrics.width * dpr);
    const height = Math.round(moved * rowHeight);
    const srcY = shift > 0 ? 0 : Math.round(-shift * rowHeight);
    const dstY = shift > 0 ? Math.round(shift * rowHeight) : 0;

    if (width <= 0 || height <= 0) return false;

    // Device-pixel space for the whole operation: the main context carries a
    // DPR scale that would otherwise double-apply to these already-scaled
    // rects.
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (this.isBackgroundOpaque()) {
      // Fast path. Drawing a canvas onto itself is specified to read from a
      // snapshot of the source, so an overlapping move is well defined. With an
      // opaque background every destination pixel is fully covered, so
      // source-over replaces rather than blends and no clear is needed. One
      // copy of the moved band, and nothing else.
      this.ctx.drawImage(this.canvas, 0, srcY, width, height, 0, dstY, width, height);
      this.ctx.restore();
      return true;
    }

    // Translucent background: source-over would blend the moved rows into
    // whatever is beneath them, so the destination has to be cleared first.
    // Clearing before copying from the same canvas would destroy the source
    // where the bands overlap, hence the detour through a scratch bitmap.
    const scratch = this.getScratchCtx();
    if (!scratch || !this.scratchCanvas) {
      this.ctx.restore();
      return false;
    }

    scratch.clearRect(0, dstY, width, height);
    scratch.drawImage(this.canvas, 0, srcY, width, height, 0, dstY, width, height);
    this.ctx.clearRect(0, dstY, width, height);
    this.ctx.drawImage(this.scratchCanvas, 0, dstY, width, height, 0, dstY, width, height);
    this.ctx.restore();

    return true;
  }

  /**
   * Whether theme.background is fully opaque, which decides if the blit can
   * move pixels in a single self-copy.
   *
   * Resolved by painting the colour and reading the alpha back, so every CSS
   * form is handled rather than just the ones a hand-written parser expects.
   * Cached because it only changes with the theme.
   */
  private isBackgroundOpaque(): boolean {
    if (this.backgroundOpaque !== null) return this.backgroundOpaque;

    let opaque = false;
    try {
      const probe = document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      const ctx = probe.getContext('2d', { alpha: true });
      if (ctx) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = this.theme.background;
        ctx.fillRect(0, 0, 1, 1);
        opaque = ctx.getImageData(0, 0, 1, 1).data[3] === 255;
      }
    } catch {
      // Tainted or unavailable context. Assume translucent, which only costs
      // the slower blit path.
      opaque = false;
    }

    this.backgroundOpaque = opaque;
    return opaque;
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;
    this.currentRenderBuffer = buffer;

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();

    // Pre-frame: build the virtual-placement index so unicode-placeholder
    // cells can look up their target image's grid layout in O(1) during
    // the per-cell text pass. Also collects direct placements + computes
    // kittyDamagedRows (rows where a placement was added/removed/moved/
    // re-decoded, so the text underneath needs repainting to clear stale
    // image pixels).
    this.precomputeKittyState(buffer, dims.rows);
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    // Whether the *caller* demanded a full repaint. Distinct from forceAll
    // below, which also absorbs the buffer's own "everything is dirty" signal.
    //
    // The distinction matters for the scroll blit. Ghostty reports FULL dirty
    // on every scroll — it relocates each row's content, so it cannot describe
    // the change as a row set. That is precisely when the blit pays off, so a
    // full-dirty buffer must not disqualify it; the row hashes decide instead,
    // and they are strictly better informed than a viewport-wide flag. A
    // caller-requested repaint is different: it means the canvas itself is
    // untrustworthy (first frame, theme swap), so no pixels may be reused.
    const callerForcedAll = forceAll;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvas.width !==
        (dims.cols * this.metrics.width + SCROLLBAR_GUTTER) * this.devicePixelRatio ||
      this.canvas.height !== dims.rows * this.metrics.height * this.devicePixelRatio;

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Floor viewportY once for row mapping. The scrollback/screen boundary
    // comparison and the offset/screenRow math must use the SAME integer.
    // During smooth scroll viewportY is fractional (e.g. 2.5); comparing rows
    // against the raw value while indexing with the floored value read one row
    // past the end of scrollback (returning null, leaving stale pixels) and
    // dropped the top screen row, duplicating a line near the top of the view.
    const flooredViewportY = Math.floor(viewportY);

    // Fetch viewport rows once per frame, on demand.
    //
    // Screen rows come from a single bulk fetch when the buffer offers one:
    // getLine() on the WASM terminal walks the whole viewport to return one
    // row, so calling it per row costs O(rows^2 * cols) WASM crossings a frame.
    // Scrollback rows are already a direct per-row grid walk, so they stay
    // individual.
    let screenLines: (GhosttyCell[] | null)[] | null = null;
    let historyLines: (GhosttyCell[] | null)[] | null = null;
    const lineCache = new Array<GhosttyCell[] | null | undefined>(dims.rows);

    // The scrollback rows on screen are always the contiguous run starting
    // here, so they can be read in one pass rather than one call per row.
    const firstHistoryOffset = scrollbackLength - flooredViewportY;
    const historyCount = Math.min(flooredViewportY, dims.rows);

    const lineAt = (y: number): GhosttyCell[] | null => {
      const cached = lineCache[y];
      if (cached !== undefined) return cached;

      let line: GhosttyCell[] | null = null;
      if (flooredViewportY > 0 && y < flooredViewportY && scrollbackProvider) {
        // Upper part of the viewport is served from scrollback. Each
        // single-row read re-allocates WASM scratch and re-fetches the whole
        // palette, which at forty rows a frame cost more than painting them.
        if (scrollbackProvider.getScrollbackLines) {
          historyLines ??= scrollbackProvider.getScrollbackLines(
            firstHistoryOffset,
            historyCount
          );
          line = historyLines[y] ?? null;
        } else {
          line = scrollbackProvider.getScrollbackLine(firstHistoryOffset + y);
        }
      } else {
        // Lower part (or the whole viewport when at the bottom) is the screen.
        const screenRow = flooredViewportY > 0 ? y - flooredViewportY : y;
        if (buffer.getViewportLines) {
          screenLines ??= buffer.getViewportLines();
          line = screenLines[screenRow] ?? null;
        } else {
          line = buffer.getLine(screenRow);
        }
      }

      lineCache[y] = line;
      return line;
    };

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Repaint the rows whose selection appearance changed since the last
    // frame, not the whole selection.
    //
    // Repainting every selected row every frame made a drag cost one repaint
    // per selected row per frame, which dominated drag cost and made the
    // dirty-row tracking in SelectionManager dead weight — whatever it
    // reported, the full range was re-added here anyway. Rows strictly inside
    // a selection look identical from frame to frame; only rows that joined or
    // left it, and the endpoint rows whose column extent moved, actually
    // change. Diffing here rather than trusting SelectionManager's dirty set
    // alone also keeps programmatic selections correct, since selectAll() and
    // select() never went through the drag path that marks rows dirty.
    const prevSel = this.previousSelectionCoords;
    const curSel = this.currentSelectionCoords;
    const selectionMoved =
      (prevSel === null) !== (curSel === null) ||
      (prevSel !== null &&
        curSel !== null &&
        (prevSel.startRow !== curSel.startRow ||
          prevSel.endRow !== curSel.endRow ||
          prevSel.startCol !== curSel.startCol ||
          prevSel.endCol !== curSel.endCol));

    if (selectionMoved) {
      if (prevSel === null || curSel === null) {
        const range = prevSel ?? curSel!;
        for (let row = range.startRow; row <= range.endRow; row++) selectionRows.add(row);
      } else {
        const lo = Math.min(prevSel.startRow, curSel.startRow);
        const hi = Math.max(prevSel.endRow, curSel.endRow);
        for (let row = lo; row <= hi; row++) {
          const was = row >= prevSel.startRow && row <= prevSel.endRow;
          const is = row >= curSel.startRow && row <= curSel.endRow;
          if (was !== is) selectionRows.add(row);
        }
        selectionRows.add(prevSel.startRow);
        selectionRows.add(prevSel.endRow);
        selectionRows.add(curSel.startRow);
        selectionRows.add(curSel.endRow);
      }
    }

    this.previousSelectionCoords = curSel === null ? null : { ...curSel };

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      for (let y = 0; y < dims.rows; y++) {
        const line = lineAt(y);
        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // ========================================================================
    // Scroll blit
    // ========================================================================

    this.ensureHashBuffers(dims.rows);

    // How far content moved since the frame on the canvas. See the Scroll Blit
    // section for the derivation.
    const scrollShift =
      flooredViewportY - this.lastFlooredViewportY - (scrollbackLength - this.lastScrollbackLength);

    const dimsUnchanged =
      this.lastDims !== null &&
      this.lastDims.cols === dims.cols &&
      this.lastDims.rows === dims.rows;

    // Overlays sit in viewport coordinates on top of the text, so a blit would
    // drag them along with the rows beneath them. They are absent during the
    // bulk output that the blit exists to speed up, so skip the fast path
    // rather than trying to reposition them.
    // Selection is deliberately absent here: its per-row extent is part of the
    // row hash, so a changed highlight fails verification and gets repainted
    // like any other change. The rest stay — hover underlines and kitty
    // placements paint outside the hashed cell data, so a moved row could
    // carry them stale with nothing to catch it.
    const hasOverlays =
      this.currentDirectPlacements.length > 0 ||
      this.kittyVirtualPlacements.size > 0 ||
      this.hoveredHyperlinkId > 0 ||
      this.hoveredLinkRange !== null;

    // Rows the blit could not carry over and that must be repainted.
    const blitExposedRows = new Set<number>();
    let blitted = false;

    if (
      this.scrollBlitEnabled &&
      !callerForcedAll &&
      !needsResize &&
      dimsUnchanged &&
      !hasOverlays &&
      // A zero shift is worth taking when scrolled, because the fallback there
      // repaints the entire viewport on the grounds that per-row dirty flags
      // describe the screen and not the view. Holding still in scrollback is
      // the common case — reading, or dragging out a selection — and nothing
      // has moved, so hash verification retains every row and only genuinely
      // changed ones get painted. At the bottom a zero shift already lands on
      // the dirty-flag path, which is cheaper than hashing the frame, so leave
      // that alone.
      (scrollShift !== 0 || viewportY > 0) &&
      Math.abs(scrollShift) < dims.rows
    ) {
      // Hash the whole frame so retained rows can be verified against the
      // pixels already on the canvas.
      this.complexRows.clear();
      for (let y = 0; y < dims.rows; y++) {
        if (this.hashRowInto(lineAt(y), y, this.frameHashA!, this.frameHashB!)) {
          this.complexRows.add(y);
        }
      }

      // A retained row is only reusable when its predecessor's pixels are
      // accounted for and hash-identical.
      const canvasA = this.canvasHashA!;
      const canvasB = this.canvasHashB!;
      const canvasValid = this.canvasHashValid!;
      const frameA = this.frameHashA!;
      const frameB = this.frameHashB!;

      const firstRetained = Math.max(0, scrollShift);
      const lastRetained = Math.min(dims.rows, dims.rows + scrollShift);

      const mismatched: number[] = [];
      for (let y = firstRetained; y < lastRetained; y++) {
        const src = y - scrollShift;
        if (
          canvasValid[src] !== 1 ||
          canvasA[src] !== frameA[y] ||
          canvasB[src] !== frameB[y] ||
          this.complexRows.has(y)
        ) {
          mismatched.push(y);
        }
      }

      // Repainting most of the viewport on top of a blit costs more than just
      // drawing the frame, so bail out when the hypothesis mostly failed.
      const retained = lastRetained - firstRetained - mismatched.length;
      // Nothing to move at zero shift; the pixels are already where they
      // belong, so skip the full-canvas self-copy blitRows would perform.
      if (
        retained > dims.rows / 2 &&
        (scrollShift === 0 || this.blitRows(scrollShift, dims.cols, dims.rows))
      ) {
        blitted = true;
        this.shiftCanvasHashes(scrollShift, dims.rows);

        // Newly exposed rows have no pixels behind them.
        if (scrollShift > 0) {
          for (let y = 0; y < scrollShift; y++) blitExposedRows.add(y);
        } else {
          for (let y = dims.rows + scrollShift; y < dims.rows; y++) blitExposedRows.add(y);
        }
        for (const y of mismatched) blitExposedRows.add(y);

        // The cursor was blitted along with its row and has to be cleared from
        // wherever it landed.
        const movedCursorRow = this.lastCursorPosition.y + scrollShift;
        if (movedCursorRow >= 0 && movedCursorRow < dims.rows) {
          blitExposedRows.add(movedCursorRow);
        }
      }
    }

    // Preserve the pre-blit behaviour when the fast path was not taken: any
    // viewport movement forces a full repaint.
    if (!blitted && viewportY !== this.lastViewportY) {
      forceAll = true;
    }
    this.lastViewportY = viewportY;

    // The cursor is drawn over the text, so both the row it left and the row it
    // occupies have to be repainted to erase and redraw it. Collected here and
    // folded into rowsToRender rather than painted immediately, so nothing
    // lands on the canvas before the blit has moved pixels around.
    const cursorRows = new Set<number>();
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    if (cursorMoved || this.cursorBlink) {
      cursorRows.add(cursor.y);
      // Always redraw the OLD cursor row to erase the previous cursor glyph
      // (issue #122: a ghost cursor persisted at the initial (0,0) position
      // because the old logic skipped this redraw when the row was already
      // dirty, but the dirty pass only runs when buffer cells changed, not
      // when the cursor moved across unchanged cells).
      if (cursorMoved) cursorRows.add(this.lastCursorPosition.y);
    }

    // Track if anything was actually rendered
    let anyLinesRendered = false;

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      let needsRender: boolean;
      if (blitted) {
        // Every row is either hash-verified against the pixels the blit moved
        // into place or already collected in blitExposedRows, so that set is
        // complete coverage.
        //
        // Deliberately ignores buffer.isRowDirty here. Scrolling relocates
        // every row's content and so marks the whole viewport dirty; honouring
        // that would repaint all of it and leave the blit doing no work at all.
        // The hash is the stronger signal — it compares actual content against
        // what is on the canvas, rather than reporting that something changed
        // somewhere in the row.
        needsRender = blitExposedRows.has(y) || cursorRows.has(y) || this.kittyDamagedRows.has(y);
      } else if (viewportY > 0) {
        // Showing scrollback, where the buffer's per-row dirty flags describe
        // the screen rather than the view, so they cannot be trusted.
        needsRender = true;
      } else {
        needsRender =
          forceAll ||
          buffer.isRowDirty(y) ||
          selectionRows.has(y) ||
          hyperlinkRows.has(y) ||
          cursorRows.has(y) ||
          this.kittyDamagedRows.has(y);
      }

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      anyLinesRendered = true;

      const line = lineAt(y);
      if (line) {
        this.renderLine(line, y, dims.cols);
      }

      // Record what this row now shows so the next frame can decide whether
      // its pixels are reusable. Rows painted on a frame that did not hash
      // everything need their hash computed here.
      if (!blitted) {
        this.hashRowInto(line, y, this.frameHashA!, this.frameHashB!);
      }
      this.commitRowHash(y);
    }
    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Composite kitty graphics images on top of the text. MVP z-order is
    // "above text" — programs sending images typically clear the cell area
    // first, so there's nothing meaningful underneath. A future commit can
    // split into below/above-text passes via PlacementLayer if real apps
    // need it.
    //
    // Skip when no rows were repainted: the previous frame's image pixels
    // are still on the canvas and unchanged, and re-issuing drawImage with
    // source-over compositing onto translucent images would accumulate
    // alpha. Placement adds/removes/moves seed kittyDamagedRows in
    // precomputeKittyState, which forces those rows into rowsToRender and
    // flips anyLinesRendered to true.
    if (this.currentDirectPlacements.length > 0 && anyLinesRendered) {
      this.renderKittyImages();
    }

    // Render cursor (only if we're at the bottom, not scrolled)
    if (viewportY === 0 && cursor.visible && this.cursorVisible) {
      // Use cursor style from buffer if provided, otherwise use renderer default
      const cursorStyle = cursor.style ?? this.cursorStyle;
      // Hand over the cached row: renderCursor needs the cell under the cursor
      // and fetching it itself would walk the whole viewport again.
      this.renderCursor(cursor.x, cursor.y, cursorStyle, lineAt(cursor.y));
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (scrollbackProvider && scrollbarOpacity > 0) {
      this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }

    // Update last cursor position
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };

    // Record the inputs the next frame's scroll shift is derived from.
    this.lastFlooredViewportY = flooredViewportY;
    this.lastScrollbackLength = scrollbackLength;
    this.lastDims = { cols: dims.cols, rows: dims.rows };

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(line: GhosttyCell[], y: number, cols: number): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y);
    }
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // Cells with the default bg let the line-level theme.background fill
    // (drawn earlier in renderLine) show through. Cells with an explicit
    // bg — including literal RGB(0,0,0) — get painted here. The cell's
    // bgIsDefault flag carries the GhosttyStyleColor tag from upstream;
    // we cannot infer it from the RGB triple because (0,0,0) is a valid
    // explicit color (programs emit it for "true black" backgrounds, e.g.
    // letterboxed image renderings).
    const useThemeBg = cell.flags & CellFlags.INVERSE ? cell.fgIsDefault : cell.bgIsDefault;
    if (!useThemeBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number, colorOverride?: string): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Kitty unicode placeholder: cells with codepoint U+10EEEE represent
    // a slice of a virtually-placed image. Substitute the slice draw for
    // text rendering. If it's not a valid placeholder (e.g., the image
    // hasn't been transmitted yet), fall through and render as text —
    // typically the system "missing glyph" box, which is the expected
    // behavior for a stray U+10EEEE.
    if (cell.codepoint === KITTY_PLACEHOLDER) {
      if (this.renderPlaceholderCell(cell, x, y)) return;
    }

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Set text style
    const isItalic = Boolean(cell.flags & CellFlags.ITALIC);
    const isBold = Boolean(cell.flags & CellFlags.BOLD);
    let fontStyle = '';
    if (isItalic) fontStyle += 'italic ';
    if (isBold) fontStyle += 'bold ';
    this.ctx.font = this.buildFontString(fontStyle);

    // Extract colors and handle inverse
    let fg_r = cell.fg_r,
      fg_g = cell.fg_g,
      fg_b = cell.fg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, foreground becomes background
      fg_r = cell.bg_r;
      fg_g = cell.bg_g;
      fg_b = cell.bg_b;
    }

    // Set text color - use override or cell color. Selected text keeps its
    // original foreground rather than being forced to theme.selectionForeground,
    // so VS Code theme colors survive selection (helper customization, ports
    // "Don't force the selection color").
    if (colorOverride) {
      this.ctx.fillStyle = colorOverride;
    } else {
      // Same reasoning as the bg path: only fall back to theme.foreground
      // when the cell has the default fg (tag NONE), not when its explicit
      // RGB happens to be (0,0,0).
      const useThemeFg = cell.flags & CellFlags.INVERSE ? cell.bgIsDefault : cell.fgIsDefault;
      this.ctx.fillStyle = useThemeFg ? this.theme.foreground : this.rgbToCSS(fg_r, fg_g, fg_b);
    }

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // Get the character to render - use grapheme lookup for complex scripts
    let char: string;
    if (cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString) {
      // Cell has additional codepoints - get full grapheme cluster
      char = this.currentBuffer.getGraphemeString(y, x);
    } else {
      // Simple cell - single codepoint
      char = String.fromCodePoint(cell.codepoint || 32); // Default to space if null
    }

    // Handle special characters that need pixel-perfect rendering:
    // - Block drawing characters (U+2580-U+259F): rectangles for gap-free ASCII art
    // - Powerline glyphs (U+E0B0-U+E0BF): vector shapes to match exact cell height
    const codepoint = cell.codepoint || 32;
    if (this.renderBlockChar(codepoint, cellX, cellY, cellWidth)) {
      // Block character was rendered as a rectangle, skip font rendering
    } else if (this.renderPowerlineGlyph(codepoint, cellX, cellY, cellWidth)) {
      // Powerline glyph was rendered as a vector shape, skip font rendering
    } else {
      this.drawGlyph(char, textX, textY, this.ctx.fillStyle as string, isBold, isItalic);
    }

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw underline
    if (cell.flags & CellFlags.UNDERLINE) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Draw hyperlink underline (for OSC8 hyperlinks)
    if (cell.hyperlink_id > 0) {
      const isHovered = cell.hyperlink_id === this.hoveredHyperlinkId;

      // Only show underline when hovered (cleaner look)
      if (isHovered) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }

    // Draw regex link underline (for plain text URLs)
    if (this.hoveredLinkRange) {
      const range = this.hoveredLinkRange;
      // Check if this cell is within the hovered link range
      const isInRange =
        (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
        (y > range.startY && y < range.endY) ||
        (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX));

      if (isInRange) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }
  }

  /**
   * Draw one glyph at a baseline origin, via the atlas when possible.
   *
   * Falls back to fillText when the atlas is off, has given up caching, or
   * cannot fit the glyph. globalAlpha is left alone so the caller's faint
   * handling applies to the blit exactly as it did to fillText.
   */
  private drawGlyph(
    text: string,
    originX: number,
    baselineY: number,
    color: string,
    bold: boolean,
    italic: boolean
  ): void {
    const atlas = this.getGlyphAtlas();
    if (atlas === null) {
      this.ctx.fillText(text, originX, baselineY);
      return;
    }

    const glyph = atlas.get(text, color, bold, italic);
    if (glyph === null) {
      this.ctx.fillText(text, originX, baselineY);
      return;
    }
    if (glyph.blank) return;

    // Source is in device pixels; the destination is in CSS pixels because the
    // context carries a DPR scale. Both cell edges and the glyph offsets are
    // whole device pixels, so the blit maps 1:1 and nothing is resampled.
    const dpr = this.devicePixelRatio;
    this.ctx.drawImage(
      atlas.bitmap,
      glyph.sx,
      glyph.sy,
      glyph.sw,
      glyph.sh,
      originX + glyph.dx / dpr,
      baselineY + glyph.dy / dpr,
      glyph.sw / dpr,
      glyph.sh / dpr
    );
  }

  /**
   * Render block drawing characters as filled rectangles for pixel-perfect rendering.
   * Returns true if the character was handled, false if it should be rendered as text.
   */
  private renderBlockChar(
    codepoint: number,
    cellX: number,
    cellY: number,
    cellWidth: number
  ): boolean {
    const height = this.metrics.height;

    // Snap a coordinate to the device-pixel grid. The cell edges are already
    // device-aligned (metrics are rounded to 1/dpr), but the internal split
    // points of partial blocks (height/2, cellWidth*3/8, ...) are not. On a
    // fractional/high DPR an unsnapped edge antialiases against the cell
    // background, leaving a hairline seam — visible as gaps between rows of
    // half-block art. Snapping the split to a physical pixel makes adjacent
    // fills (and the cell background) tile exactly.
    const dpr = this.devicePixelRatio;
    const snap = (v: number): number => Math.round(v * dpr) / dpr;

    // Vertical band between two fractions of the cell height (0 = top, 1 = bottom).
    const vfill = (f0: number, f1: number): void => {
      const y0 = snap(cellY + height * f0);
      const y1 = snap(cellY + height * f1);
      this.ctx.fillRect(cellX, y0, cellWidth, y1 - y0);
    };

    // Horizontal band between two fractions of the cell width (0 = left, 1 = right).
    const hfill = (f0: number, f1: number): void => {
      const x0 = snap(cellX + cellWidth * f0);
      const x1 = snap(cellX + cellWidth * f1);
      this.ctx.fillRect(x0, cellY, x1 - x0, height);
    };

    // Rectangular sub-cell region (fractions of width/height), device-snapped.
    // Used for the quadrant blocks (U+2596-U+259F).
    const qfill = (fx0: number, fy0: number, fx1: number, fy1: number): void => {
      const x0 = snap(cellX + cellWidth * fx0);
      const x1 = snap(cellX + cellWidth * fx1);
      const y0 = snap(cellY + height * fy0);
      const y1 = snap(cellY + height * fy1);
      this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    };

    // Block Elements (U+2580-U+259F)
    switch (codepoint) {
      case 0x2580: // ▀ UPPER HALF BLOCK
        vfill(0, 1 / 2);
        return true;
      case 0x2581: // ▁ LOWER ONE EIGHTH BLOCK
        vfill(7 / 8, 1);
        return true;
      case 0x2582: // ▂ LOWER ONE QUARTER BLOCK
        vfill(3 / 4, 1);
        return true;
      case 0x2583: // ▃ LOWER THREE EIGHTHS BLOCK
        vfill(5 / 8, 1);
        return true;
      case 0x2584: // ▄ LOWER HALF BLOCK
        vfill(1 / 2, 1);
        return true;
      case 0x2585: // ▅ LOWER FIVE EIGHTHS BLOCK
        vfill(3 / 8, 1);
        return true;
      case 0x2586: // ▆ LOWER THREE QUARTERS BLOCK
        vfill(1 / 4, 1);
        return true;
      case 0x2587: // ▇ LOWER SEVEN EIGHTHS BLOCK
        vfill(1 / 8, 1);
        return true;
      case 0x2588: // █ FULL BLOCK
        this.ctx.fillRect(cellX, cellY, cellWidth, height);
        return true;
      case 0x2589: // ▉ LEFT SEVEN EIGHTHS BLOCK
        hfill(0, 7 / 8);
        return true;
      case 0x258a: // ▊ LEFT THREE QUARTERS BLOCK
        hfill(0, 3 / 4);
        return true;
      case 0x258b: // ▋ LEFT FIVE EIGHTHS BLOCK
        hfill(0, 5 / 8);
        return true;
      case 0x258c: // ▌ LEFT HALF BLOCK
        hfill(0, 1 / 2);
        return true;
      case 0x258d: // ▍ LEFT THREE EIGHTHS BLOCK
        hfill(0, 3 / 8);
        return true;
      case 0x258e: // ▎ LEFT ONE QUARTER BLOCK
        hfill(0, 1 / 4);
        return true;
      case 0x258f: // ▏ LEFT ONE EIGHTH BLOCK
        hfill(0, 1 / 8);
        return true;
      case 0x2590: // ▐ RIGHT HALF BLOCK
        hfill(1 / 2, 1);
        return true;
      case 0x2594: // ▔ UPPER ONE EIGHTH BLOCK
        vfill(0, 1 / 8);
        return true;
      case 0x2595: // ▕ RIGHT ONE EIGHTH BLOCK
        hfill(7 / 8, 1);
        return true;

      // Quadrant blocks (U+2596-U+259F). Cell split into four equal quarters.
      case 0x2596: // ▖ QUADRANT LOWER LEFT
        qfill(0, 1 / 2, 1 / 2, 1);
        return true;
      case 0x2597: // ▗ QUADRANT LOWER RIGHT
        qfill(1 / 2, 1 / 2, 1, 1);
        return true;
      case 0x2598: // ▘ QUADRANT UPPER LEFT
        qfill(0, 0, 1 / 2, 1 / 2);
        return true;
      case 0x2599: // ▙ QUADRANT UPPER LEFT AND LOWER LEFT AND LOWER RIGHT
        qfill(0, 0, 1 / 2, 1 / 2);
        qfill(0, 1 / 2, 1, 1);
        return true;
      case 0x259a: // ▚ QUADRANT UPPER LEFT AND LOWER RIGHT
        qfill(0, 0, 1 / 2, 1 / 2);
        qfill(1 / 2, 1 / 2, 1, 1);
        return true;
      case 0x259b: // ▛ QUADRANT UPPER LEFT AND UPPER RIGHT AND LOWER LEFT
        qfill(0, 0, 1, 1 / 2);
        qfill(0, 1 / 2, 1 / 2, 1);
        return true;
      case 0x259c: // ▜ QUADRANT UPPER LEFT AND UPPER RIGHT AND LOWER RIGHT
        qfill(0, 0, 1, 1 / 2);
        qfill(1 / 2, 1 / 2, 1, 1);
        return true;
      case 0x259d: // ▝ QUADRANT UPPER RIGHT
        qfill(1 / 2, 0, 1, 1 / 2);
        return true;
      case 0x259e: // ▞ QUADRANT UPPER RIGHT AND LOWER LEFT
        qfill(1 / 2, 0, 1, 1 / 2);
        qfill(0, 1 / 2, 1 / 2, 1);
        return true;
      case 0x259f: // ▟ QUADRANT UPPER RIGHT AND LOWER LEFT AND LOWER RIGHT
        qfill(1 / 2, 0, 1, 1 / 2);
        qfill(0, 1 / 2, 1, 1);
        return true;
      default:
        return false;
    }
  }

  /**
   * Render Powerline glyphs as vector shapes for pixel-perfect cell height.
   * Powerline glyphs (U+E0B0-U+E0BF) are designed to span the full cell height,
   * but font rendering often makes them slightly taller/shorter than the cell.
   * Drawing them as paths ensures they exactly fill the cell bounds.
   * Returns true if the character was handled, false if it should be rendered as text.
   */
  private renderPowerlineGlyph(
    codepoint: number,
    cellX: number,
    cellY: number,
    cellWidth: number
  ): boolean {
    const height = this.metrics.height;
    const ctx = this.ctx;

    switch (codepoint) {
      case 0xe0b0: // Right-pointing triangle (hard divider)
        ctx.beginPath();
        ctx.moveTo(cellX, cellY);
        ctx.lineTo(cellX + cellWidth, cellY + height / 2);
        ctx.lineTo(cellX, cellY + height);
        ctx.closePath();
        ctx.fill();
        return true;

      case 0xe0b1: // Right-pointing angle (soft divider, thin)
        ctx.beginPath();
        ctx.moveTo(cellX, cellY);
        ctx.lineTo(cellX + cellWidth, cellY + height / 2);
        ctx.lineTo(cellX, cellY + height);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
        return true;

      case 0xe0b2: // Left-pointing triangle (hard divider)
        ctx.beginPath();
        ctx.moveTo(cellX + cellWidth, cellY);
        ctx.lineTo(cellX, cellY + height / 2);
        ctx.lineTo(cellX + cellWidth, cellY + height);
        ctx.closePath();
        ctx.fill();
        return true;

      case 0xe0b3: // Left-pointing angle (soft divider, thin)
        ctx.beginPath();
        ctx.moveTo(cellX + cellWidth, cellY);
        ctx.lineTo(cellX, cellY + height / 2);
        ctx.lineTo(cellX + cellWidth, cellY + height);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
        return true;

      case 0xe0b4: // Right semicircle (filled)
        ctx.beginPath();
        ctx.moveTo(cellX, cellY);
        // Ellipse curving right: center at left edge, radii = cellWidth (x) and height/2 (y)
        ctx.ellipse(
          cellX,
          cellY + height / 2,
          cellWidth,
          height / 2,
          0,
          -Math.PI / 2,
          Math.PI / 2,
          false
        );
        ctx.closePath();
        ctx.fill();
        return true;

      case 0xe0b5: // Right semicircle (outline)
        ctx.beginPath();
        ctx.moveTo(cellX, cellY);
        ctx.ellipse(
          cellX,
          cellY + height / 2,
          cellWidth,
          height / 2,
          0,
          -Math.PI / 2,
          Math.PI / 2,
          false
        );
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
        return true;

      case 0xe0b6: // Left semicircle (filled) - rounded left cap
        ctx.beginPath();
        ctx.moveTo(cellX + cellWidth, cellY);
        // Ellipse curving left: center at right edge, radii = cellWidth (x) and height/2 (y)
        ctx.ellipse(
          cellX + cellWidth,
          cellY + height / 2,
          cellWidth,
          height / 2,
          0,
          -Math.PI / 2,
          Math.PI / 2,
          true
        );
        ctx.closePath();
        ctx.fill();
        return true;

      case 0xe0b7: // Left semicircle (outline)
        ctx.beginPath();
        ctx.moveTo(cellX + cellWidth, cellY);
        ctx.ellipse(
          cellX + cellWidth,
          cellY + height / 2,
          cellWidth,
          height / 2,
          0,
          -Math.PI / 2,
          Math.PI / 2,
          true
        );
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
        return true;

      default:
        return false;
    }
  }

  /**
   * Composite all visible kitty graphics placements onto the canvas.
   * Cheap when no graphics are active (one method check, one terminal_get).
   * Decode work is amortized across frames via kittyImageCache.
   */
  /**
   * Walk the placement iterator once at frame start, partitioning the
   * results: virtual placements go into kittyVirtualPlacements (keyed
   * by image id) for placeholder-cell lookup; direct visible placements
   * stay implicit and get re-iterated by renderKittyImages later.
   *
   * Also caches the storage handle for renderPlaceholderCell so the
   * per-cell hot path doesn't have to re-resolve it.
   */
  private precomputeKittyState(buffer: IRenderable, dimsRows: number): void {
    this.kittyVirtualPlacements.clear();
    this.currentDirectPlacements = [];
    this.kittyDamagedRows.clear();
    this.currentKittyGraphics = null;

    const newSigs: typeof this.lastKittyDirectSigs = new Map();
    const cellH = this.metrics.height;
    const markRows = (viewportRow: number, pixelHeight: number): void => {
      const rowStart = Math.max(0, Math.floor(viewportRow));
      const rowEnd = Math.min(dimsRows, Math.ceil(viewportRow + pixelHeight / cellH));
      for (let r = rowStart; r < rowEnd; r++) this.kittyDamagedRows.add(r);
    };

    if (buffer.getKittyGraphics && buffer.iterPlacements) {
      const graphics = buffer.getKittyGraphics();
      if (graphics !== null) {
        this.currentKittyGraphics = graphics;
        // onlyVisible=false so virtual placements come through too. We
        // partition: virtuals into kittyVirtualPlacements (placeholder-cell
        // lookup), directs into currentDirectPlacements (composite pass).
        for (const p of buffer.iterPlacements(graphics, false)) {
          if (p.isVirtual) {
            this.kittyVirtualPlacements.set(p.imageId, p);
            continue;
          }
          this.currentDirectPlacements.push(p);
          const pixels = buffer.getKittyImagePixels?.(graphics, p.imageId);
          const sig = {
            viewportCol: p.viewportCol,
            viewportRow: p.viewportRow,
            pixelWidth: p.pixelWidth,
            pixelHeight: p.pixelHeight,
            sourceX: p.sourceX,
            sourceY: p.sourceY,
            sourceWidth: p.sourceWidth,
            sourceHeight: p.sourceHeight,
            imgWidth: pixels?.width ?? 0,
            imgHeight: pixels?.height ?? 0,
            imgFormat: pixels?.format ?? (0 as KittyImageFormat),
            dataPtr: pixels?.data.byteOffset ?? 0,
            dataLen: pixels?.data.length ?? 0,
          };
          newSigs.set(p.imageId, sig);
          const prev = this.lastKittyDirectSigs.get(p.imageId);
          const changed =
            !prev ||
            prev.viewportCol !== sig.viewportCol ||
            prev.viewportRow !== sig.viewportRow ||
            prev.pixelWidth !== sig.pixelWidth ||
            prev.pixelHeight !== sig.pixelHeight ||
            prev.sourceX !== sig.sourceX ||
            prev.sourceY !== sig.sourceY ||
            prev.sourceWidth !== sig.sourceWidth ||
            prev.sourceHeight !== sig.sourceHeight ||
            prev.imgWidth !== sig.imgWidth ||
            prev.imgHeight !== sig.imgHeight ||
            prev.imgFormat !== sig.imgFormat ||
            prev.dataPtr !== sig.dataPtr ||
            prev.dataLen !== sig.dataLen;
          if (changed) {
            markRows(sig.viewportRow, sig.pixelHeight);
            if (prev) markRows(prev.viewportRow, prev.pixelHeight);
          }
        }
      }
    }

    // Removed placements (were drawn last frame, gone now): mark their
    // rows so text repaint clears stale image pixels.
    for (const [id, prev] of this.lastKittyDirectSigs) {
      if (!newSigs.has(id)) markRows(prev.viewportRow, prev.pixelHeight);
    }
    this.lastKittyDirectSigs = newSigs;
  }

  /**
   * Get (or decode + cache) the canvas-ready bitmap for a kitty image.
   * Returns null if the image isn't stored or decode fails. Shared by
   * renderKittyImages (direct placements) and renderPlaceholderCell
   * (unicode-placeholder cells).
   */
  private getOrDecodeKittyImage(
    buffer: IRenderable,
    graphics: number,
    imageId: number
  ): HTMLCanvasElement | null {
    const cached = this.kittyImageCache.get(imageId);
    const pixels = buffer.getKittyImagePixels?.(graphics, imageId);
    if (!pixels) return cached?.canvas ?? null;
    if (cached && cachedMatchesPixels(cached, pixels)) return cached.canvas;
    const canvas = this.decodeKittyImageToCanvas(pixels);
    if (!canvas) return null;
    this.kittyImageCache.set(imageId, {
      canvas,
      width: pixels.width,
      height: pixels.height,
      format: pixels.format,
      dataPtr: pixels.data.byteOffset,
      dataLen: pixels.data.length,
    });
    return canvas;
  }

  /**
   * Render a Block Elements codepoint (U+2580..U+259F) as fillRect(s) in
   * the current fillStyle. Returns true if the codepoint is a handled
   * block element; false to fall through to fillText.
   *
   * Drawing block elements through the font produces ~1-device-px gaps
   * at cell edges at integer dpr because the rasterized glyph doesn't
   * exactly fill the cell box. In half-block image renderings (ansimage,
   * pixterm) those gaps line up into a visible cell grid. Native
   * terminals draw block elements programmatically for the same reason.
   *
   * The eighths blocks (U+2581..U+2587 lower; U+2589..U+258F left) and
   * full block (U+2588) are stripes of n/8 of the cell. Shading blocks
   * (U+2591..U+2593) modulate globalAlpha for 25/50/75% fill. Quadrant
   * blocks (U+2596..U+259F) split the cell into a 2x2 grid and fill
   * some subset.
   */
  private renderBlockElement(
    codepoint: number,
    cellX: number,
    cellY: number,
    cellWidth: number
  ): boolean {
    if (codepoint < 0x2580 || codepoint > 0x259f) return false;

    const w = cellWidth;
    const h = this.metrics.height;

    // Upper half ▀
    if (codepoint === 0x2580) {
      this.ctx.fillRect(cellX, cellY, w, Math.round(h / 2));
      return true;
    }

    // Lower n/8 blocks ▁▂▃▄▅▆▇ + full block █ (= 8/8)
    if (codepoint >= 0x2581 && codepoint <= 0x2588) {
      const eighths = codepoint - 0x2580;
      const blockH = Math.round((h * eighths) / 8);
      this.ctx.fillRect(cellX, cellY + h - blockH, w, blockH);
      return true;
    }

    // Left n/8 blocks ▉▊▋▌▍▎▏ — eighths decreases as codepoint increases
    if (codepoint >= 0x2589 && codepoint <= 0x258f) {
      const eighths = 0x2590 - codepoint;
      const blockW = Math.round((w * eighths) / 8);
      this.ctx.fillRect(cellX, cellY, blockW, h);
      return true;
    }

    // Right half ▐
    if (codepoint === 0x2590) {
      const left = Math.round(w / 2);
      this.ctx.fillRect(cellX + left, cellY, w - left, h);
      return true;
    }

    // Shading ░▒▓ — modulate globalAlpha against current fillStyle
    if (codepoint >= 0x2591 && codepoint <= 0x2593) {
      const alphaForShade = [0.25, 0.5, 0.75][codepoint - 0x2591];
      const prev = this.ctx.globalAlpha;
      this.ctx.globalAlpha = prev * alphaForShade;
      this.ctx.fillRect(cellX, cellY, w, h);
      this.ctx.globalAlpha = prev;
      return true;
    }

    // Upper 1/8 ▔
    if (codepoint === 0x2594) {
      this.ctx.fillRect(cellX, cellY, w, Math.round(h / 8));
      return true;
    }

    // Right 1/8 ▕
    if (codepoint === 0x2595) {
      const left = Math.round((w * 7) / 8);
      this.ctx.fillRect(cellX + left, cellY, w - left, h);
      return true;
    }

    // Quadrants ▖▗▘▙▚▛▜▝▞▟ at U+2596..U+259F. Bitmap of which corners
    // (UL, UR, LL, LR) are filled per codepoint.
    const QUAD_UL = 0b1000;
    const QUAD_UR = 0b0100;
    const QUAD_LL = 0b0010;
    const QUAD_LR = 0b0001;
    const quadMap: Record<number, number> = {
      9622: QUAD_LL,
      9623: QUAD_LR,
      9624: QUAD_UL,
      9625: QUAD_UL | QUAD_LL | QUAD_LR,
      9626: QUAD_UL | QUAD_LR,
      9627: QUAD_UL | QUAD_UR | QUAD_LL,
      9628: QUAD_UL | QUAD_UR | QUAD_LR,
      9629: QUAD_UR,
      9630: QUAD_UR | QUAD_LL,
      9631: QUAD_UR | QUAD_LL | QUAD_LR,
    };
    const quads = quadMap[codepoint];
    if (quads === undefined) return false;
    const halfW = Math.round(w / 2);
    const halfH = Math.round(h / 2);
    if (quads & QUAD_UL) this.ctx.fillRect(cellX, cellY, halfW, halfH);
    if (quads & QUAD_UR) this.ctx.fillRect(cellX + halfW, cellY, w - halfW, halfH);
    if (quads & QUAD_LL) this.ctx.fillRect(cellX, cellY + halfH, halfW, h - halfH);
    if (quads & QUAD_LR) this.ctx.fillRect(cellX + halfW, cellY + halfH, w - halfW, h - halfH);
    return true;
  }

  /**
   * Substitute a cell's text rendering with a slice of a kitty graphics
   * image. Called from renderCellText when the cell's codepoint is
   * U+10EEEE.
   *
   * Decodes the image_id from cell.fg_*  (low 24 bits; high byte from
   * an optional third combining diacritic) and the row/col-of-image
   * from the first two combining diacritics on the cell. Looks up the
   * virtual placement (from precomputeKittyState) for grid dims, then
   * draws the matching slice scaled to one terminal cell.
   *
   * Returns true if the cell was handled as a placeholder; false to
   * fall through to normal text rendering (e.g., unknown image, no
   * matching virtual placement, or malformed diacritics).
   */
  private renderPlaceholderCell(cell: GhosttyCell, x: number, y: number): boolean {
    const buffer = this.currentRenderBuffer;
    const graphics = this.currentKittyGraphics;
    if (!buffer || graphics === null || !buffer.getGrapheme) return false;

    // Image id from fg color (low 24 bits) + optional 3rd diacritic
    // (high byte). The base codepoint at index 0 is U+10EEEE itself;
    // [1]=row, [2]=col, [3]=image_id_msb (optional).
    const codepoints = buffer.getGrapheme(y, x);
    if (!codepoints || codepoints.length < 3) return false;
    const rowD = diacriticToInt(codepoints[1]!);
    const colD = diacriticToInt(codepoints[2]!);
    if (rowD < 0 || colD < 0) return false;
    const fgRgb = (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
    let imageId = fgRgb;
    if (codepoints.length >= 4) {
      const msb = diacriticToInt(codepoints[3]!);
      if (msb >= 0) imageId = (msb << 24) | fgRgb;
    }

    const placement = this.kittyVirtualPlacements.get(imageId);
    if (!placement) return false;

    const pixels = buffer.getKittyImagePixels?.(graphics, imageId);
    if (!pixels) return false;
    const canvas = this.getOrDecodeKittyImage(buffer, graphics, imageId);
    if (!canvas) return false;

    // Slice geometry: image is conceptually scaled to fit
    // gridCols × gridRows cells; this cell shows one of those cells.
    const srcW = pixels.width / placement.gridCols;
    const srcH = pixels.height / placement.gridRows;
    const srcX = colD * srcW;
    const srcY = rowD * srcH;
    const destX = x * this.metrics.width;
    const destY = y * this.metrics.height;

    // Source-rect coords are fractional whenever pixels.{width,height} doesn't
    // divide evenly by placement.{gridCols,gridRows}. With smoothing on, each
    // slice is sampled with bilinear interpolation clamped to its own source
    // rect, producing visible seams between adjacent cells (the classic
    // tile-edge artifact). Disable smoothing for the slice draw.
    const prevSmoothing = this.ctx.imageSmoothingEnabled;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      canvas,
      srcX,
      srcY,
      srcW,
      srcH,
      destX,
      destY,
      this.metrics.width,
      this.metrics.height
    );
    this.ctx.imageSmoothingEnabled = prevSmoothing;
    return true;
  }

  private renderKittyImages(): void {
    const buffer = this.currentRenderBuffer;
    const graphics = this.currentKittyGraphics;
    if (!buffer || graphics === null || !buffer.getKittyImagePixels) return;

    for (const p of this.currentDirectPlacements) {
      let cached = this.kittyImageCache.get(p.imageId);
      const pixels = buffer.getKittyImagePixels(graphics, p.imageId);
      if (!pixels) continue;

      // Cache miss or stale (image was re-transmitted under the same id).
      // See kittyImageCache docstring for staleness-key rationale.
      if (!cached || !cachedMatchesPixels(cached, pixels)) {
        const canvas = this.decodeKittyImageToCanvas(pixels);
        if (!canvas) continue;
        cached = {
          canvas,
          width: pixels.width,
          height: pixels.height,
          format: pixels.format,
          dataPtr: pixels.data.byteOffset,
          dataLen: pixels.data.length,
        };
        this.kittyImageCache.set(p.imageId, cached);
      }

      // Composite. Source/dest rects come straight from the C ABI's
      // PlacementRenderInfo; viewport_col/row may be negative when a
      // placement has scrolled partway off the top — drawImage handles
      // that correctly (clips to the canvas).
      this.ctx.drawImage(
        cached.canvas,
        p.sourceX,
        p.sourceY,
        p.sourceWidth,
        p.sourceHeight,
        p.viewportCol * this.metrics.width,
        p.viewportRow * this.metrics.height,
        p.pixelWidth,
        p.pixelHeight
      );
    }
  }

  /**
   * Decode a kitty graphics image into a canvas suitable for drawImage.
   * Expands non-RGBA formats into RGBA via putImageData; PNG payloads
   * (which require a JS-side decoder set up via ghostty_sys_set) are
   * not supported in this MVP and return null.
   */
  private decodeKittyImageToCanvas(pixels: KittyImagePixels): HTMLCanvasElement | null {
    const { width, height, format, data } = pixels;
    if (width === 0 || height === 0) return null;

    // Allocate a fresh ArrayBuffer (not a WASM-memory view) so that
    //   (a) the bytes survive the next vt_write that might detach the
    //       WASM memory buffer, and
    //   (b) ImageData accepts the buffer (it rejects ArrayBufferLike
    //       which would include SharedArrayBuffer).
    const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    switch (format) {
      case KittyImageFormat.RGBA:
        rgba.set(data);
        break;
      case KittyImageFormat.RGB:
        for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
          rgba[o] = data[i]!;
          rgba[o + 1] = data[i + 1]!;
          rgba[o + 2] = data[i + 2]!;
          rgba[o + 3] = 255;
        }
        break;
      case KittyImageFormat.GRAY:
        for (let i = 0, o = 0; i < data.length; i++, o += 4) {
          const v = data[i]!;
          rgba[o] = v;
          rgba[o + 1] = v;
          rgba[o + 2] = v;
          rgba[o + 3] = 255;
        }
        break;
      case KittyImageFormat.GRAY_ALPHA:
        for (let i = 0, o = 0; i < data.length; i += 2, o += 4) {
          const v = data[i]!;
          rgba[o] = v;
          rgba[o + 1] = v;
          rgba[o + 2] = v;
          rgba[o + 3] = data[i + 1]!;
        }
        break;
      default:
        // PNG and unknown formats — skip silently. The terminal would have
        // dropped a PNG payload at parse time anyway unless a decoder was
        // installed via ghostty_sys_set(DECODE_PNG, fn).
        return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas;
  }

  /**
   * Render cursor
   *
   * `line` is the cursor row, supplied by the caller because it already has the
   * frame's rows cached. Fetching it here instead cost a full viewport walk per
   * frame, since getLine() on the WASM terminal reads every cell of every row
   * to return one of them.
   */
  private renderCursor(
    x: number,
    y: number,
    style?: 'block' | 'underline' | 'bar',
    line?: GhosttyCell[] | null
  ): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;
    const cursorStyle = style ?? this.cursorStyle;

    this.ctx.fillStyle = this.theme.cursor;

    switch (cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        {
          if (line?.[x]) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            this.renderCellText(line[x], x, y, this.theme.cursorAccent);
            this.ctx.restore();
          }
        }
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  /**
   * Set a callback the renderer invokes when its internal state changes
   * outside the normal render-driven path (today: cursor-blink toggles).
   * Lets an event-driven Terminal wake its render scheduler instead of
   * polling every frame to catch the blink flip.
   */
  public setOnRequestRender(fn: (() => void) | null): void {
    this.onRequestRender = fn;
  }

  /**
   * Wake the host's render scheduler.
   *
   * For collaborators that change what should be on screen without going
   * through a write. Nothing schedules a frame on its own, so a selection drag
   * over an idle terminal would otherwise only repaint when something else
   * happened to request a frame — in practice the 530ms cursor blink, which
   * is two updates a second no matter how fast the pointer moves.
   */
  public requestRender(): void {
    this.onRequestRender?.();
  }

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      // Wake the render scheduler so the cursor cell is actually
      // repainted with the new visibility state.
      this.onRequestRender?.();
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };

    // Rebuild palette
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Cells that use the default fg/bg resolve their colour from the theme at
    // paint time, so their pixels change while their hashed content does not.
    // Drop the blit state so no stale-themed row gets reused.
    this.invalidateScrollBlitState();
    this.backgroundOpaque = null;
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
    this.invalidateGlyphAtlas();
    this.invalidateScrollBlitState();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
    this.invalidateGlyphAtlas();
    this.invalidateScrollBlitState();
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  /**
   * Get current font metrics
   */

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.clearRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = viewportY / scrollbackLength; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    // Track and thumb colors come from the theme. The fade-in/out (opacity)
    // and the idle dim are applied via globalAlpha so they compose over
    // whatever base color the theme provides, instead of being baked into a
    // hardcoded rgba string.
    ctx.save();

    // Track: only drawn if the theme provides one. By default it's empty so the
    // gutter stays the terminal background, like VS Code's own scrollbars.
    if (this.theme.scrollbarTrack) {
      ctx.globalAlpha = opacity;
      ctx.fillStyle = this.theme.scrollbarTrack;
      ctx.fillRect(scrollbarX, scrollbarPadding, scrollbarWidth, scrollbarTrackHeight);
    }

    // Thumb: dimmed to 60% when resting at the bottom, full when scrolled.
    // (Matches the previous 0.3-vs-0.5 alpha split against the 0.5 default.)
    const idleDim = viewportY > 0 ? 1 : 0.6;
    ctx.globalAlpha = opacity * idleDim;
    ctx.fillStyle = this.theme.scrollbarThumb;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);

    ctx.restore();
  }
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    if (this.hoveredHyperlinkId === hyperlinkId) return;
    this.hoveredHyperlinkId = hyperlinkId;
    this.onRequestRender?.();
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    // Coarse change check — link-detection is rate-limited upstream and
    // these setters are only called on hover transitions, so identity
    // comparison is enough to dedupe back-to-back clears.
    if (this.hoveredLinkRange === range) return;
    this.hoveredLinkRange = range;
    this.onRequestRender?.();
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.invalidateScrollBlitState();
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
    this.invalidateGlyphAtlas();

    if (this.scratchCanvas) {
      this.scratchCanvas.width = 0;
      this.scratchCanvas.height = 0;
      this.scratchCanvas = null;
      this.scratchCtx = null;
    }
  }
}
