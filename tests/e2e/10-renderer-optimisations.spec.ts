import { expect, test } from '@playwright/test';

// Guards the renderer's two drawing optimisations against regressions by
// rendering identical content with each one switched on and off.
//
// The glyph atlas and the scroll blit are both invisible when they work and
// produce subtly wrong output when they don't — a glyph off by a pixel, a row
// of stale text after a scroll — which behavioural tests would not catch. So
// this compares bitmaps directly.
test('glyph atlas and scroll blit match the unoptimised paths', async ({ page }) => {
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto('/demo/', { waitUntil: 'networkidle' });

  const result = await page.evaluate(async () => {
    const { CanvasRenderer } = await import('/lib/renderer.ts');

    const COLS = 60;
    const ROWS = 20;
    const TOTAL_LINES = 200;

    const mk = (ch: string, o: Record<string, unknown> = {}) => ({
      codepoint: ch.codePointAt(0) ?? 32,
      fg_r: 212,
      fg_g: 212,
      fg_b: 212,
      bg_r: 30,
      bg_g: 30,
      bg_b: 30,
      fgIsDefault: true,
      bgIsDefault: true,
      flags: 0,
      width: 1,
      hyperlink_id: 0,
      grapheme_len: 0,
      ...o,
    });

    // Flags mirror CellFlags in lib/types.ts.
    const BOLD = 1 << 0;
    const ITALIC = 1 << 1;
    const UNDERLINE = 1 << 2;
    const INVERSE = 1 << 4;
    const STRIKETHROUGH = 1 << 6;
    const FAINT = 1 << 7;

    type Cell = ReturnType<typeof mk>;

    // A stable corpus of absolute lines. Each carries its own index in the text
    // so a row landing at the wrong offset after a blit is unmissable, and the
    // styles cycle through every path the atlas has to reproduce.
    const corpus: Cell[][] = [];
    for (let n = 0; n < TOTAL_LINES; n++) {
      const label = `line ${n} `;
      const row: Cell[] = [];
      const variant = n % 9;
      for (let x = 0; x < COLS; x++) {
        if (x < label.length) {
          row.push(mk(label[x]));
          continue;
        }
        const k = (x + n) % 10;
        switch (variant) {
          case 0:
            row.push(mk(String.fromCharCode(33 + ((x * 3) % 90))));
            break;
          case 1:
            row.push(mk('B', { flags: BOLD }));
            break;
          case 2:
            row.push(mk('i', { flags: ITALIC }));
            break;
          case 3:
            row.push(mk('u', { flags: UNDERLINE }));
            break;
          case 4:
            row.push(mk('s', { flags: STRIKETHROUGH }));
            break;
          case 5:
            row.push(mk('v', { flags: INVERSE }));
            break;
          case 6:
            row.push(mk('f', { flags: FAINT }));
            break;
          case 7:
            row.push(
              mk('C', {
                fg_r: 20 + k * 20,
                fg_g: 200 - k * 10,
                fg_b: 80 + k * 15,
                fgIsDefault: false,
                bg_r: k * 10,
                bg_g: 40,
                bg_b: 90,
                bgIsDefault: false,
              })
            );
            break;
          default:
            row.push(x % 3 === 0 ? mk(' ') : x % 3 === 1 ? mk('▀') : mk('T'));
        }
      }
      corpus.push(row);
    }

    /**
     * Buffer view over the corpus for a given scroll position: the screen shows
     * absolute lines [first, first + ROWS), scrollback holds everything before
     * it. Mirrors how a real terminal reports a stream of output at the bottom.
     */
    const makeView = (first: number) => {
      const screen: Cell[][] = [];
      for (let y = 0; y < ROWS; y++) screen.push(corpus[first + y] ?? []);
      return {
        buffer: {
          getLine: (y: number) => screen[y] ?? null,
          getViewportLines: () => screen.slice(),
          getCursor: () => ({ x: 0, y: 0, visible: false }),
          getDimensions: () => ({ cols: COLS, rows: ROWS }),
          // A scroll relocates every row, which is exactly what a real
          // terminal reports: the whole viewport is dirty.
          isRowDirty: () => true,
          needsFullRedraw: () => false,
          clearDirty: () => {},
          getGraphemeString: (y: number, x: number) =>
            String.fromCodePoint(screen[y]?.[x]?.codepoint || 32),
        },
        scrollback: {
          getScrollbackLength: () => first,
          getScrollbackLine: (offset: number) => corpus[offset] ?? null,
        },
      };
    };

    // Count painted rows by intercepting the per-row clearRect that renderLine
    // issues. Row clears are identifiable by their height matching a cell.
    let rowClears = 0;
    let countHeight = 0;
    const origClearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (
      x: number,
      y: number,
      w: number,
      h: number
    ) {
      if (countHeight > 0 && x === 0 && Math.abs(h - countHeight) < 0.001) rowClears++;
      return origClearRect.call(this, x, y, w, h);
    };

    const runStream = (opts: Record<string, unknown>, frames: number) => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const r = new CanvasRenderer(canvas, {
        fontSize: 15,
        fontFamily: 'monospace',
        devicePixelRatio: 2,
        ...opts,
      });
      r.resize(COLS, ROWS);

      // First frame is a full paint in both configurations; start counting
      // after it so the comparison covers steady-state streaming only.
      const first0 = makeView(0);
      r.render(first0.buffer as never, true, 0, first0.scrollback as never, 0);

      countHeight = r.getMetrics().height;
      rowClears = 0;
      for (let f = 1; f <= frames; f++) {
        const v = makeView(f);
        r.render(v.buffer as never, false, 0, v.scrollback as never, 0);
      }
      const painted = rowClears;
      countHeight = 0;

      const ctx = canvas.getContext('2d')!;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { data: Array.from(img.data), w: canvas.width, h: canvas.height, painted };
    };

    const compare = (
      a: { data: number[]; w: number; h: number },
      b: { data: number[]; w: number; h: number }
    ) => {
      if (a.w !== b.w || a.h !== b.h) return { sizeMismatch: true, diff: -1, maxDelta: -1 };
      let diff = 0;
      let maxDelta = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        let d = 0;
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
        if (d > 0) diff++;
        if (d > maxDelta) maxDelta = d;
      }
      return {
        sizeMismatch: false,
        diff,
        total: a.data.length / 4,
        pct: ((diff / (a.data.length / 4)) * 100).toFixed(4),
        maxDelta,
      };
    };

    const FRAMES = 40;

    // Baseline: no atlas, no blit — the original rendering path.
    const plain = runStream({ glyphAtlas: false, scrollBlit: false }, FRAMES);
    // Atlas only, isolating glyph rasterisation from the blit.
    const atlasOnly = runStream({ glyphAtlas: true, scrollBlit: false }, FRAMES);
    // Both, the shipping configuration.
    const both = runStream({ glyphAtlas: true, scrollBlit: true }, FRAMES);

    CanvasRenderingContext2D.prototype.clearRect = origClearRect;

    return {
      atlasVsPlain: compare(atlasOnly, plain),
      bothVsPlain: compare(both, plain),
      bothVsAtlas: compare(both, atlasOnly),
      rowsPainted: { plain: plain.painted, atlasOnly: atlasOnly.painted, both: both.painted },
      frames: FRAMES,
      rows: ROWS,
    };
  });

  console.log(JSON.stringify(result, null, 2));

  // The atlas rasterises at device scale in an unscaled context rather than at
  // CSS scale in a scaled one, so antialiasing rounds differently. A delta of a
  // couple of levels on a channel is that rounding; anything larger would be a
  // real positioning or colour bug.
  expect(result.atlasVsPlain.sizeMismatch).toBe(false);
  expect(result.atlasVsPlain.maxDelta).toBeLessThanOrEqual(2);

  // The blit only ever moves already-rendered pixels, so against the atlas-only
  // run it must be exact.
  expect(result.bothVsAtlas.sizeMismatch).toBe(false);
  expect(result.bothVsAtlas.maxDelta).toBe(0);
  expect(result.bothVsAtlas.diff).toBe(0);

  expect(result.bothVsPlain.maxDelta).toBeLessThanOrEqual(2);

  // The blit has to actually save work: a one-row scroll should repaint a
  // couple of rows, not the whole viewport.
  expect(result.rowsPainted.plain).toBe(result.frames * result.rows);
  expect(result.rowsPainted.both).toBeLessThan(result.rowsPainted.plain / 4);
});

// The blit used to be disabled outright whenever anything was selected, because
// it moves pixels with the highlight already painted into them and the row hash
// only covered cell content — a row whose highlight changed would hash
// identical and be retained with a stale selection. That meant every frame of a
// drag repainted the entire viewport, which is the common case: dragging a
// selection while the viewport auto-scrolls.
//
// The row hash now includes the row's selected column span, so a changed
// highlight fails verification like any other change. This guards that: the
// selection moves every frame while the viewport scrolls, and the blitted
// output must be pixel-identical to a full repaint.
test('scroll blit is exact while a selection is being dragged', async ({ page }) => {
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto('/demo/', { waitUntil: 'networkidle' });

  const result = await page.evaluate(async () => {
    const { CanvasRenderer } = await import('/lib/renderer.ts');

    const COLS = 40;
    const ROWS = 16;
    const FRAMES = 24;
    const TOTAL = 200;

    const mk = (ch: string) => ({
      codepoint: ch.codePointAt(0) ?? 32,
      fg_r: 212, fg_g: 212, fg_b: 212,
      bg_r: 30, bg_g: 30, bg_b: 30,
      fgIsDefault: true, bgIsDefault: true,
      flags: 0, width: 1, hyperlink_id: 0, grapheme_len: 0,
    });
    type Cell = ReturnType<typeof mk>;

    const corpus: Cell[][] = [];
    for (let n = 0; n < TOTAL; n++) {
      const label = `row ${n} `.padEnd(COLS, 'abcdefgh');
      corpus.push([...label.slice(0, COLS)].map(mk));
    }

    const makeView = (first: number) => {
      const screen: Cell[][] = [];
      for (let y = 0; y < ROWS; y++) screen.push(corpus[first + y] ?? []);
      return {
        buffer: {
          getLine: (y: number) => screen[y] ?? null,
          getViewportLines: () => screen.slice(),
          getCursor: () => ({ x: 0, y: 0, visible: false }),
          getDimensions: () => ({ cols: COLS, rows: ROWS }),
          isRowDirty: () => true,
          needsFullRedraw: () => false,
          clearDirty: () => {},
          getGraphemeString: (y: number, x: number) =>
            String.fromCodePoint(screen[y]?.[x]?.codepoint || 32),
        },
        scrollback: {
          getScrollbackLength: () => first,
          getScrollbackLine: (offset: number) => corpus[offset] ?? null,
        },
      };
    };

    // A selection whose end walks down and right, as a drag would.
    const selAt = (f: number) => ({
      startCol: 3,
      startRow: 2,
      endCol: 5 + (f % (COLS - 6)),
      endRow: 4 + (f % (ROWS - 5)),
    });

    let rowClears = 0;
    let countHeight = 0;
    const origClearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (
      x: number, y: number, w: number, h: number
    ) {
      if (countHeight > 0 && x === 0 && Math.abs(h - countHeight) < 0.001) rowClears++;
      return origClearRect.call(this, x, y, w, h);
    };

    const run = (scrollBlit: boolean) => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const r = new CanvasRenderer(canvas, {
        fontSize: 15, fontFamily: 'monospace', devicePixelRatio: 2,
        glyphAtlas: true, scrollBlit,
      });
      r.resize(COLS, ROWS);

      let coords = selAt(0);
      r.setSelectionManager({
        hasSelection: () => true,
        getSelectionCoords: () => coords,
        getDirtySelectionRows: () => new Set<number>(),
        clearDirtySelectionRows: () => {},
      } as never);

      // Parked 8 rows up inside a real scrollback, so the top of the viewport
      // is served from scrollback and the bottom from the screen — the split
      // the blit has to get right. Starting at 100 guarantees the scrollback
      // is deep enough that those rows resolve to real lines.
      const v0 = makeView(100);
      r.render(v0.buffer as never, true, 8, v0.scrollback as never, 0);

      countHeight = r.getMetrics().height;
      rowClears = 0;
      for (let f = 1; f <= FRAMES; f++) {
        coords = selAt(f);
        // Scrollback grows by one line a frame while the viewport stays 8 rows
        // up, which is a one-row shift per frame: an auto-scrolling drag.
        const v = makeView(100 + f);
        r.render(v.buffer as never, false, 8, v.scrollback as never, 0);
      }
      const painted = rowClears;
      countHeight = 0;

      const ctx = canvas.getContext('2d')!;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { data: Array.from(img.data), w: canvas.width, h: canvas.height, painted };
    };

    const off = run(false);
    const on = run(true);

    let diff = 0;
    let maxDelta = 0;
    for (let i = 0; i < off.data.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(off.data[i + c] - on.data[i + c]));
      if (d > 0) diff++;
      if (d > maxDelta) maxDelta = d;
    }

    return {
      sizeMismatch: off.w !== on.w || off.h !== on.h,
      diff, maxDelta, total: off.data.length / 4,
      painted: { off: off.painted, on: on.painted },
      frames: FRAMES, rows: ROWS,
    };
  });

  console.log(JSON.stringify(result, null, 2));

  // Any stale highlight left behind by a retained row shows up here.
  expect(result.sizeMismatch).toBe(false);
  expect(result.maxDelta).toBe(0);
  expect(result.diff).toBe(0);

  // Without the blit this is a guaranteed full repaint every frame, which is
  // the thing being fixed.
  expect(result.painted.off).toBe(result.frames * result.rows);

  // The saving is modest here by construction: the selection end moves every
  // single frame and periodically snaps back, so a large share of rows really
  // do change their highlight and have to be repainted. A gentler drag saves
  // far more. What matters is that a full repaint is no longer guaranteed.
  expect(result.painted.on).toBeLessThan(result.painted.off * 0.8);
});

// Hovering a link disables the blit (hasOverlays), so the frame where the hover
// clears is the first frame the blit runs on. The row hash covers cell content,
// not whether a link underline is painted over it, so those rows were retained
// with the underline still on them and the blit then carried those pixels along
// with the text on every later scroll. The underline ended up glued a row below
// the link and stayed there.
test('clearing a hovered link underline survives the blit', async ({ page }) => {
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto('/demo/', { waitUntil: 'networkidle' });

  const result = await page.evaluate(async () => {
    const { CanvasRenderer } = await import('/lib/renderer.ts');

    const COLS = 40;
    const ROWS = 10;
    const TOTAL = 100;

    const mk = (ch: string) => ({
      codepoint: ch.codePointAt(0) ?? 32,
      fg_r: 212, fg_g: 212, fg_b: 212,
      bg_r: 30, bg_g: 30, bg_b: 30,
      fgIsDefault: true, bgIsDefault: true,
      flags: 0, width: 1, hyperlink_id: 0, grapheme_len: 0,
    });
    type Cell = ReturnType<typeof mk>;

    const corpus: Cell[][] = [];
    for (let n = 0; n < TOTAL; n++) {
      corpus.push([...`row ${n} `.padEnd(COLS, 'xyz').slice(0, COLS)].map(mk));
    }

    const makeView = (first: number) => {
      const screen: Cell[][] = [];
      for (let y = 0; y < ROWS; y++) screen.push(corpus[first + y] ?? []);
      return {
        buffer: {
          getLine: (y: number) => screen[y] ?? null,
          getViewportLines: () => screen.slice(),
          getCursor: () => ({ x: 0, y: 0, visible: false }),
          getDimensions: () => ({ cols: COLS, rows: ROWS }),
          isRowDirty: () => true,
          needsFullRedraw: () => false,
          clearDirty: () => {},
          getGraphemeString: (y: number, x: number) =>
            String.fromCodePoint(screen[y]?.[x]?.codepoint || 32),
        },
        scrollback: {
          getScrollbackLength: () => first,
          getScrollbackLine: (offset: number) => corpus[offset] ?? null,
        },
      };
    };

    const run = (scrollBlit: boolean) => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const r = new CanvasRenderer(canvas, {
        fontSize: 15, fontFamily: 'monospace', devicePixelRatio: 2,
        glyphAtlas: true, scrollBlit,
      });
      r.resize(COLS, ROWS);

      // Parked in scrollback with a two-row link underlined, the way a hover
      // over a wrapped URL leaves it.
      const v0 = makeView(50);
      r.setHoveredLinkRange({ startX: 4, startY: 3, endX: 20, endY: 4 });
      r.render(v0.buffer as never, true, 6, v0.scrollback as never, 0);

      // The pointer has not moved, but one line of scroll puts different
      // content under it, so the hover clears on this frame.
      r.setHoveredLinkRange(null);
      const v1 = makeView(51);
      r.render(v1.buffer as never, false, 6, v1.scrollback as never, 0);

      // Two more scrolls, which is where the stale pixels used to ride along.
      for (let f = 2; f <= 3; f++) {
        const v = makeView(51 + f - 1);
        r.render(v.buffer as never, false, 6, v.scrollback as never, 0);
      }

      const ctx = canvas.getContext('2d')!;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { data: Array.from(img.data), w: canvas.width, h: canvas.height };
    };

    const off = run(false);
    const on = run(true);

    let diff = 0;
    let maxDelta = 0;
    for (let i = 0; i < off.data.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(off.data[i + c] - on.data[i + c]));
      if (d > 0) diff++;
      if (d > maxDelta) maxDelta = d;
    }
    return { sizeMismatch: off.w !== on.w || off.h !== on.h, diff, maxDelta, total: off.data.length / 4 };
  });

  console.log(JSON.stringify(result, null, 2));

  // A retained underline shows up here as a band of blue pixels.
  expect(result.sizeMismatch).toBe(false);
  expect(result.maxDelta).toBe(0);
  expect(result.diff).toBe(0);
});

// Two OSC8 links on screen, hovering one. cell.hyperlink_id is 1 for any
// hyperlinked cell rather than a per-link identity, so drawing the underline by
// comparing it against the hovered id lit every link at once. The giveaway is
// that hovering the first link and hovering the second produced identical
// output; with the underline driven by the hovered link's real extent they
// must differ.
test('hovering one link underlines only that link', async ({ page }) => {
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto('/demo/', { waitUntil: 'networkidle' });

  const result = await page.evaluate(async () => {
    const { CanvasRenderer } = await import('/lib/renderer.ts');

    const COLS = 30;
    const ROWS = 6;

    const mk = (ch: string, hyperlink: boolean) => ({
      codepoint: ch.codePointAt(0) ?? 32,
      fg_r: 212, fg_g: 212, fg_b: 212,
      bg_r: 30, bg_g: 30, bg_b: 30,
      fgIsDefault: true, bgIsDefault: true,
      flags: 0, width: 1,
      hyperlink_id: hyperlink ? 1 : 0,
      grapheme_len: 0,
    });
    type Cell = ReturnType<typeof mk>;

    // Rows 1 and 3 are links; identical text so any difference between the two
    // captures has to come from which one is underlined.
    const screen: Cell[][] = [];
    for (let y = 0; y < ROWS; y++) {
      const isLink = y === 1 || y === 3;
      const text = isLink ? 'https://example.com/x'.padEnd(COLS) : `plain row ${y}`.padEnd(COLS);
      screen.push([...text.slice(0, COLS)].map((ch, x) => mk(ch, isLink && x < 21)));
    }

    const buffer = {
      getLine: (y: number) => screen[y] ?? null,
      getViewportLines: () => screen.slice(),
      getCursor: () => ({ x: 0, y: 0, visible: false }),
      getDimensions: () => ({ cols: COLS, rows: ROWS }),
      isRowDirty: () => true,
      needsFullRedraw: () => false,
      clearDirty: () => {},
      getGraphemeString: (y: number, x: number) =>
        String.fromCodePoint(screen[y]?.[x]?.codepoint || 32),
    };
    const scrollback = { getScrollbackLength: () => 0, getScrollbackLine: () => null };

    const renderHovering = (row: number) => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const r = new CanvasRenderer(canvas, {
        fontSize: 15, fontFamily: 'monospace', devicePixelRatio: 2,
      });
      r.resize(COLS, ROWS);
      // Both are set the way a real hover does: the id says "a link is hovered",
      // the range says which one.
      r.setHoveredHyperlinkId(1);
      r.setHoveredLinkRange({ startX: 0, startY: row, endX: 20, endY: row });
      r.render(buffer as never, true, 0, scrollback as never, 0);
      const ctx = canvas.getContext('2d')!;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return Array.from(img.data);
    };

    const hoverFirst = renderHovering(1);
    const hoverSecond = renderHovering(3);

    let diff = 0;
    for (let i = 0; i < hoverFirst.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(hoverFirst[i + c] - hoverSecond[i + c]));
      if (d > 0) diff++;
    }
    return { diff, total: hoverFirst.length / 4 };
  });

  console.log(JSON.stringify(result));

  // Identical output would mean both links were underlined in both cases.
  expect(result.diff).toBeGreaterThan(0);
});
