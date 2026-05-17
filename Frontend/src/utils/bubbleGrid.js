// src/utils/bubbleGrid.js
// General OMR layout detector.
//
// Auto-detects the sheet layout instead of assuming a fixed grid:
//   • any number of questions          • single OR multi-column layouts
//   • any number of choices per row    • any sheet size / resolution
//   • circular OR square bubbles       • corrects moderate rotation/skew
// It also reads which bubble is filled in each question.
//
// Returns null when the layout cannot be read confidently — the caller then
// falls back to the AI scanner.
//
// Result shape:
//   {
//     questions: [ { bubbles:[{x,y}], marked:int, confidence:float } ],
//     radius: float,                       // all coords are 0-1 fractions
//     meta: { rows, columns, choices }
//   }

const WORK_W = 1500; // images are normalised to this width before analysis

/**
 * @param {object}  cv          - OpenCV runtime (window.cv)
 * @param {*}       imageSource  - the OMR image
 * @param {object} [template]   - optional locked layout
 *                                {questions, choices, columns}
 */
export function detectOMRLayout(cv, imageSource, template) {
  if (!cv || !cv.imread || !imageSource) return null;
  const tpl = (template && template.choices >= 2 && template.columns >= 1
    && template.questions >= 1) ? template : null;

  const srcW = imageSource.naturalWidth || imageSource.videoWidth || imageSource.width;
  const srcH = imageSource.naturalHeight || imageSource.videoHeight || imageSource.height;
  if (!srcW || !srcH) return null;

  const WORK_H = Math.max(1, Math.round((srcH / srcW) * WORK_W));
  const canvas = document.createElement("canvas");
  canvas.width = WORK_W;
  canvas.height = WORK_H;
  canvas.getContext("2d").drawImage(imageSource, 0, 0, WORK_W, WORK_H);

  let src, gray, blur, thresh, contours, hierarchy;
  try {
    src = cv.imread(canvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    thresh = new cv.Mat();
    cv.adaptiveThreshold(
      blur, thresh, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 10,
    );
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    // 1) Candidate bubbles: small, square-ish, genuinely circular shapes.
    const imgArea = WORK_W * WORK_H;
    const cands = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < imgArea * 0.00004 || area > imgArea * 0.02) { cnt.delete(); continue; }
      const rect = cv.boundingRect(cnt);
      const aspect = rect.width / rect.height;
      if (aspect < 0.6 || aspect > 1.7) { cnt.delete(); continue; }
      const peri = cv.arcLength(cnt, true);
      if (peri <= 0) { cnt.delete(); continue; }
      // Only accept genuinely round shapes — a real bubble is a circle
      // (circularity ~0.85-1.0). This rejects letters/labels such as the
      // "Q. No. A B C D" column header (A,B,C,D score well below 0.72).
      const circ = (4 * Math.PI * area) / (peri * peri);
      if (circ < 0.72) { cnt.delete(); continue; }
      cands.push({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        r: (rect.width + rect.height) / 4,
      });
      cnt.delete();
    }
    if (cands.length < 4) return null;

    // 2) Keep consistent-size bubbles, merge duplicates, drop stray shapes.
    const radii = cands.map((c) => c.r).sort((a, b) => a - b);
    const medR = radii[radii.length >> 1];
    let pts = cands.filter((c) => c.r > medR * 0.55 && c.r < medR * 1.9);
    pts = dedupe(pts, medR * 0.85);
    pts = densityFilter(pts);
    if (pts.length < 4) return null;

    // 3) De-skew: rotate a *copy* of the coordinates so rows become horizontal.
    //    Original x/y are kept for drawing and mark-reading.
    const angle = estimateSkew(pts, medR);
    const cx = WORK_W / 2, cy = WORK_H / 2;
    const cosA = Math.cos(-angle), sinA = Math.sin(-angle);
    for (const p of pts) {
      const dx = p.x - cx, dy = p.y - cy;
      p.rx = cx + dx * cosA - dy * sinA;
      p.ry = cy + dx * sinA + dy * cosA;
    }

    // 3b) Keep only bubbles that belong to a tall vertical column. Answer-
    //     choice columns are full stacks of bubbles; the question-number
    //     column (boxed "1,2,3…") is a short, irregular strip and is dropped.
    pts = columnAlignFilter(pts, medR);
    if (pts.length < 4) return null;

    // 4) Cluster bubbles into rows by their (de-skewed) Y.
    let rows = clusterByGap(pts, (p) => p.ry, medR * 1.3);
    if (rows.length < 1) return null;

    // 5) Isolate the answer grid: the longest run of evenly-spaced rows.
    //    This drops header/footer noise (example circles, roll-number boxes,
    //    booklet-code boxes, instructions, etc.).
    rows = dominantRows(rows);
    if (rows.length < 1) return null;
    const countMode = modeOf(rows.map((r) => r.length));
    rows = rows.filter((r) => r.length >= Math.max(2, countMode * 0.5));
    if (rows.length < 1) return null;

    // Drop label rows whose shapes are the wrong size to be answer bubbles —
    // e.g. the "Q. No. A B C D" column header, whose bare letters are smaller
    // than the printed answer circles. Real answer rows all sit near medR.
    rows = rows.filter((row) => {
      const rr = median(row.map((p) => p.r));
      return rr >= medR * 0.8 && rr <= medR * 1.3;
    });
    if (rows.length < 1) return null;

    // 6-9) Determine the choices-per-question and the column layout.
    let C;
    let cols;
    if (tpl) {
      // TEMPLATE: the layout is locked — split each row into exactly the known
      // number of columns, deterministically (no fragile gap guessing).
      C = tpl.choices;
      const K = tpl.columns;
      const buckets = Array.from({ length: K }, () => []);
      for (const row of rows) {
        const parts = splitRowFixed(row, K);
        for (let j = 0; j < K && j < parts.length; j++) {
          const sorted = parts[j];
          buckets[j].push({
            bubbles: sorted,
            rxc: avg(sorted.map((p) => p.rx)),
            ryc: avg(sorted.map((p) => p.ry)),
          });
        }
      }
      cols = buckets.filter((b) => b.length);
    } else {
      // AUTO: find the vertical bubble columns ("strips"), then group those
      // strips into question-blocks by the largest relative gap jump. This is
      // robust on dense sheets where the block gap is only modestly wider than
      // the choice gap.
      let strips = clusterByGap(pts, (p) => p.rx, medR * 1.3);
      const maxStrip = Math.max(...strips.map((s) => s.length));
      strips = strips.filter((s) => s.length >= Math.max(3, maxStrip * 0.4));
      if (!strips.length) return null;
      const stripX = strips
        .map((s) => median(s.map((p) => p.rx)))
        .sort((a, b) => a - b);

      const blocks = groupStripsIntoBlocks(stripX); // array of arrays of x
      C = modeOf(blocks.map((b) => b.length));

      // Split each row into column-groups using each block's x-range.
      cols = blocks.map(() => []);
      for (const row of rows) {
        for (let bi = 0; bi < blocks.length; bi++) {
          const lo = blocks[bi][0] - medR * 1.6;
          const hi = blocks[bi][blocks[bi].length - 1] + medR * 1.6;
          const part = row
            .filter((p) => p.rx >= lo && p.rx <= hi)
            .sort((a, b) => a.rx - b.rx);
          if (part.length) {
            cols[bi].push({
              bubbles: part,
              rxc: avg(part.map((p) => p.rx)),
              ryc: avg(part.map((p) => p.ry)),
            });
          }
        }
      }
      cols = cols.filter((c) => c.length);
    }
    if (C < 2 || C > 12 || !cols.length) return null;
    cols.sort((a, b) => avg(a.map((g) => g.rxc)) - avg(b.map((g) => g.rxc)));

    // 10) Build a clean C-bubble grid for every question and sample the
    //     brightness of every bubble.
    const sampleR = Math.max(2, medR * 0.52);
    const columnsRaw = [];
    for (const col of cols) {
      const built = buildColumn(col, C);
      if (!built) return null;
      columnsRaw.push(built.map((bubbles) => ({
        bubbles,
        means: cellMeans(blur, bubbles, sampleR),
      })));
    }

    // 11) Reference brightness of an empty bubble (most bubbles are empty).
    const allMeans = [];
    for (const col of columnsRaw) {
      for (const q of col) for (const m of q.means) allMeans.push(m);
    }
    allMeans.sort((a, b) => a - b);
    const emptyRef = allMeans[Math.floor(allMeans.length * 0.7)] || 255;
    const brightT = emptyRef * 0.82; // a bubble brighter than this is "empty"

    // 12) Build question objects: filled choice + count of empty bubbles.
    const columnsQ = columnsRaw.map((col) =>
      col.map((q) => {
        const r = readMarkFromMeans(q.means);
        return {
          bubbles: q.bubbles,
          marked: r.marked,
          confidence: r.confidence,
          bright: q.means.filter((m) => m > brightT).length,
        };
      }),
    );

    // 13) Drop a shared label row ("Q. No. A B C D"): the first/last row of
    //     EVERY column whose cells are all printed labels — a label row has
    //     almost no *empty* bubbles, unlike every real answer row.
    dropSharedLabelRow(columnsQ, C, true);
    dropSharedLabelRow(columnsQ, C, false);

    // 13b) TEMPLATE: enforce the exact row count per column. Extra rows (stray
    //      header/footer labels) are trimmed from whichever end is least like
    //      a real answer row (fewest empty bubbles).
    if (tpl) {
      const expRows = Math.max(1, Math.round(tpl.questions / tpl.columns));
      for (const col of columnsQ) {
        while (col.length > expRows && col.length > 1) {
          if (col[0].bright <= col[col.length - 1].bright) col.shift();
          else col.pop();
        }
      }
    }

    // 14) Flatten column-major (down each column) — standard OMR numbering.
    const ordered = [];
    for (const c of columnsQ) for (const q of c) ordered.push(q);
    if (ordered.length < 1 || ordered.length > 400) return null;

    const questions = ordered.map((q) => ({
      bubbles: q.bubbles.map((b) => ({ x: b.x / WORK_W, y: b.y / WORK_H })),
      marked: q.marked,
      confidence: q.confidence,
    }));

    return {
      questions,
      radius: medR / WORK_W,
      meta: {
        rows: columnsQ.reduce((m, c) => Math.max(m, c.length), 0),
        columns: cols.length,
        choices: C,
      },
    };
  } catch (e) {
    console.warn("detectOMRLayout failed:", e);
    return null;
  } finally {
    [src, gray, blur, thresh, contours, hierarchy].forEach((m) => {
      try { m && m.delete(); } catch { /* noop */ }
    });
  }
}

/** Merge points closer than minDist into one (averaged) point. */
function dedupe(pts, minDist) {
  const out = [];
  for (const p of pts) {
    const near = out.find((q) => Math.hypot(p.x - q.x, p.y - q.y) < minDist);
    if (near) {
      near.x = (near.x + p.x) / 2;
      near.y = (near.y + p.y) / 2;
      near.r = Math.max(near.r, p.r);
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

/**
 * Keep only bubbles that sit in a tall vertical column. Each answer-choice
 * column is a full stack of bubbles (one per question row). A question-number
 * column, header letters, or stray marks form only short/sparse strips, so
 * they have far fewer vertically-aligned neighbours and get dropped.
 */
function columnAlignFilter(pts, medR) {
  if (pts.length < 16) return pts;
  const tol = medR * 0.7;
  const counts = pts.map((p) => {
    let n = 0;
    for (const q of pts) {
      if (q !== p && Math.abs(q.rx - p.rx) <= tol) n += 1;
    }
    return n;
  });
  const maxCount = Math.max(...counts);
  if (maxCount < 6) return pts; // too few rows to discriminate
  const need = Math.max(5, maxCount * 0.5);
  const kept = pts.filter((_, i) => counts[i] >= need);
  return kept.length >= 8 ? kept : pts;
}

/** Keep only points inside a dense cluster (drops logos / stray circles). */
function densityFilter(pts) {
  if (pts.length < 6) return pts;
  const nn = pts
    .map((p) => {
      let best = Infinity;
      for (const q of pts) {
        if (q === p) continue;
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < best) best = d;
      }
      return best;
    })
    .sort((a, b) => a - b);
  const medNN = nn[nn.length >> 1] || 1;
  const reach = medNN * 2.4;
  const kept = pts.filter((p) => {
    let cnt = 0;
    for (const q of pts) {
      if (q !== p && Math.hypot(p.x - q.x, p.y - q.y) <= reach) cnt += 1;
    }
    return cnt >= 3;
  });
  return kept.length >= 4 ? kept : pts;
}

/** Estimate sheet rotation from the direction to each bubble's right neighbour. */
function estimateSkew(pts, medR) {
  const angles = [];
  for (const p of pts) {
    let best = null;
    let bd = Infinity;
    for (const q of pts) {
      if (q === p) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      if (dx <= 0 || Math.abs(dy) > medR * 1.5) continue;
      const d = Math.hypot(dx, dy);
      if (d < bd && d < medR * 9) { bd = d; best = { dx, dy }; }
    }
    if (best) angles.push(Math.atan2(best.dy, best.dx));
  }
  if (!angles.length) return 0;
  angles.sort((a, b) => a - b);
  const med = angles[angles.length >> 1];
  // Ignore implausible angles — the sheet is expected to be roughly upright.
  return Math.abs(med) > 0.26 ? 0 : med;
}

/**
 * Keep only the answer grid: the longest run of consecutive rows that are
 * evenly spaced. Header/footer blocks are separated by an irregular gap.
 */
function dominantRows(rows) {
  if (rows.length <= 2) return rows;
  const ry = rows.map((r) => median(r.map((p) => p.ry)));
  const gaps = [];
  for (let i = 1; i < ry.length; i++) gaps.push(ry[i] - ry[i - 1]);
  const medGap = median(gaps);
  if (medGap <= 0) return rows;

  let bestStart = 0, bestEnd = 0, curStart = 0;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] >= medGap * 0.55 && gaps[i] <= medGap * 1.7) {
      if (i + 1 - curStart > bestEnd - bestStart) {
        bestStart = curStart;
        bestEnd = i + 1;
      }
    } else {
      curStart = i + 1;
    }
  }
  return rows.slice(bestStart, bestEnd + 1);
}

/**
 * Build a clean grid for one question-column. Every question gets exactly C
 * bubbles: detected ones are kept, missing ones are interpolated from the
 * row's spacing, and extra detections are discarded.
 * Returns an array (top → bottom) of C-length bubble lists, or null.
 */
function buildColumn(groups, C) {
  if (!groups || !groups.length) return null;
  const col = groups.slice().sort((a, b) => a.ryc - b.ryc);

  // Canonical choice-X positions (de-skewed) from every bubble in the column.
  const allRx = [];
  for (const g of col) for (const b of g.bubbles) allRx.push(b.rx);
  const choiceXs = kmeans1D(allRx, C);
  if (!choiceXs) return null;

  // Per-slot median original X — fallback when a whole row barely detected.
  const slotXvals = Array.from({ length: C }, () => []);
  for (const g of col) {
    for (const b of g.bubbles) slotXvals[nearestIdx(choiceXs, b.rx)].push(b.x);
  }
  const slotX = slotXvals.map((v) => (v.length ? median(v) : 0));

  const out = [];
  for (const g of col) {
    const slots = new Array(C).fill(null);
    for (const b of g.bubbles) {
      const si = nearestIdx(choiceXs, b.rx);
      if (!slots[si]) {
        slots[si] = b;
      } else if (Math.abs(b.rx - choiceXs[si]) < Math.abs(slots[si].rx - choiceXs[si])) {
        slots[si] = b; // keep the bubble nearer the slot centre
      }
    }
    const present = [];
    for (let s = 0; s < C; s++) {
      if (slots[s]) present.push({ s, x: slots[s].x, y: slots[s].y });
    }
    if (!present.length) continue;

    let fx = null, fy = null;
    if (present.length >= 2) {
      fx = linfit(present.map((p) => p.s), present.map((p) => p.x));
      fy = linfit(present.map((p) => p.s), present.map((p) => p.y));
    }
    const rowY = avg(present.map((p) => p.y));
    const bubbles = [];
    for (let s = 0; s < C; s++) {
      if (slots[s]) bubbles.push({ x: slots[s].x, y: slots[s].y });
      else if (fx) bubbles.push({ x: fx(s), y: fy(s) });
      else bubbles.push({ x: slotX[s], y: rowY });
    }
    out.push(bubbles);
  }
  return out.length ? out : null;
}

/**
 * Remove a shared header/footer label row (e.g. "Q. No. A B C D") from the
 * per-column question grids, in place. A label row is unmarked in every
 * column AND noticeably darker than the answer rows beside it (printed
 * letters read darker than bright empty circles). The relative-darkness
 * test keeps it from ever removing a genuine all-blank answer row.
 */
function dropSharedLabelRow(columnsQ, C, atTop) {
  if (columnsQ.length < 2) return;
  const cand = columnsQ.map((c) => (atTop ? c[0] : c[c.length - 1]));
  if (cand.some((q) => !q)) return;

  for (let i = 0; i < columnsQ.length; i++) {
    const col = columnsQ[i];
    if (col.length < 4) return; // too short to judge safely
    const body = atTop
      ? col.slice(1, 7)
      : col.slice(Math.max(1, col.length - 7), col.length - 1);
    const bodyBright = median(body.map((q) => q.bright));
    // A label row ("A B C D" legend) has its bubbles filled with printed
    // letters — almost no empty bubbles, far fewer than a real answer row.
    if (!(cand[i].bright <= C * 0.35 && cand[i].bright < bodyBright - C * 0.3)) {
      return; // this column's edge row looks like a real question → keep all
    }
  }
  for (const c of columnsQ) (atTop ? c.shift() : c.pop());
}

/** Least-squares line fit; returns a predictor f(x). */
function linfit(xs, ys) {
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) {
    const mean = sy / n;
    return () => mean;
  }
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return (x) => slope * x + intercept;
}

/**
 * Group sorted strip x-positions into question-blocks. Finds the "elbow" —
 * the largest relative jump in gap size — so it works even when the gap
 * between blocks is only modestly wider than the gap between choices.
 * Returns an array of blocks, each an array of strip x-positions.
 */
function groupStripsIntoBlocks(stripX) {
  const n = stripX.length;
  if (n < 2) return [stripX.slice()];
  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push({ i, g: stripX[i] - stripX[i - 1] });
  const desc = gaps.slice().sort((a, b) => b.g - a.g);

  let cutCount = 0;
  let bestRatio = 1;
  for (let k = 0; k < desc.length - 1; k++) {
    const ratio = desc[k].g / (desc[k + 1].g || 1e-6);
    if (ratio > bestRatio) { bestRatio = ratio; cutCount = k + 1; }
  }
  if (bestRatio < 1.35 || cutCount < 1) return [stripX.slice()]; // one block

  const cuts = desc.slice(0, cutCount).map((x) => x.i).sort((a, b) => a - b);
  const blocks = [];
  let start = 0;
  for (const c of cuts) { blocks.push(stripX.slice(start, c)); start = c; }
  blocks.push(stripX.slice(start));
  return blocks;
}

/** Split a row of bubbles into exactly K groups at the K-1 widest x-gaps. */
function splitRowFixed(row, K) {
  const s = row.slice().sort((a, b) => a.rx - b.rx);
  if (K <= 1 || s.length <= K) return [s];
  const gaps = [];
  for (let i = 1; i < s.length; i++) gaps.push({ i, g: s[i].rx - s[i - 1].rx });
  gaps.sort((a, b) => b.g - a.g);
  const cuts = gaps.slice(0, K - 1).map((x) => x.i).sort((a, b) => a - b);
  const out = [];
  let start = 0;
  for (const c of cuts) { out.push(s.slice(start, c)); start = c; }
  out.push(s.slice(start));
  return out;
}

/** Sort by keyFn, then split wherever the gap to the next item exceeds gap. */
function clusterByGap(items, keyFn, gap) {
  if (!items.length) return [];
  const sorted = items.slice().sort((a, b) => keyFn(a) - keyFn(b));
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (keyFn(sorted[i]) - keyFn(sorted[i - 1]) > gap) {
      groups.push(cur);
      cur = [];
    }
    cur.push(sorted[i]);
  }
  groups.push(cur);
  return groups;
}

/**
 * Decide the gap that separates question-columns. Returns Infinity for a
 * single-column sheet (so rows are never split).
 */
function separatorGap(gaps, numRows) {
  if (gaps.length < 3) return Infinity;
  const km = kmeans1D(gaps, 2);
  if (!km) return Infinity;
  const [small, big] = km;
  if (big < small * 1.7) return Infinity; // only one gap scale → single column
  const mid = (small + big) / 2;
  // Real separators are systematic: roughly one per row per extra column.
  const bigCount = gaps.filter((g) => g > mid).length;
  if (bigCount < Math.max(1, numRows * 0.5)) return Infinity;
  return mid;
}

/** 1-D k-means with a known cluster count; returns sorted centres or null. */
function kmeans1D(values, k) {
  if (values.length < k) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-6) return null;

  let centers = [];
  for (let i = 0; i < k; i++) centers.push(min + ((max - min) * (i + 0.5)) / k);

  for (let iter = 0; iter < 40; iter++) {
    const sums = new Array(k).fill(0);
    const counts = new Array(k).fill(0);
    for (const v of values) {
      const bi = nearestIdx(centers, v);
      sums[bi] += v;
      counts[bi] += 1;
    }
    let moved = 0;
    for (let i = 0; i < k; i++) {
      if (counts[i] > 0) {
        const nc = sums[i] / counts[i];
        moved += Math.abs(nc - centers[i]);
        centers[i] = nc;
      }
    }
    if (moved < 0.5) break;
  }

  const counts = new Array(k).fill(0);
  for (const v of values) counts[nearestIdx(centers, v)] += 1;
  if (counts.some((c) => c === 0)) return null;
  return centers.slice().sort((a, b) => a - b);
}

function nearestIdx(centers, v) {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const d = Math.abs(v - centers[i]);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/**
 * Read the filled bubble in one question by comparing darkness.
 * Per-question comparison means an uneven lighting gradient does not matter.
 */
function cellMeans(grayMat, bubbles, sampleR) {
  return bubbles.map((b) => diskMean(grayMat, b.x, b.y, sampleR));
}

/**
 * Decide the filled bubble from pre-computed cell brightness means.
 * A bubble is "filled" when it is clearly darker than the *empty* bubbles in
 * the same question. The threshold is adaptive (scales with sheet brightness)
 * with a low absolute floor, so even faint pencil marks are caught — while
 * the empty-bubble-to-empty-bubble variation stays safely below it.
 */
function readMarkFromMeans(means) {
  if (!means.length) return { marked: -1, confidence: 0.4 };
  const order = means.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const darkest = order[0];

  // Empty-bubble reference = the brightest cells (certainly unmarked).
  const refN = Math.min(2, order.length - 1) || 1;
  const empties = order.slice(order.length - refN);
  const emptyRef = empties.reduce((s, x) => s + x.v, 0) / empties.length;

  // How much darker the darkest bubble is than an empty one.
  const contrast = emptyRef - darkest.v;
  // Adaptive "is it a mark" threshold — clearly above empty-vs-empty noise.
  const need = Math.max(16, emptyRef * 0.1);

  if (contrast >= need) {
    const conf = Math.max(0.5, Math.min(1, contrast / Math.max(1, emptyRef * 0.55)));
    return { marked: darkest.i, confidence: conf };
  }
  return { marked: -1, confidence: 0.4 };
}

/** Mean grayscale intensity of a disk (0 = black, 255 = white). */
function diskMean(mat, cx, cy, r) {
  const cols = mat.cols;
  const rows = mat.rows;
  const data = mat.data; // Uint8Array, single channel
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(cols - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(rows - 1, Math.ceil(cy + r));
  const r2 = r * r;
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        sum += data[y * cols + x];
        n += 1;
      }
    }
  }
  return n > 0 ? sum / n : 255;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function modeOf(arr) {
  const counts = new Map();
  let best = arr[0];
  let bestCount = 0;
  for (const v of arr) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) { bestCount = c; best = v; }
  }
  return best;
}
