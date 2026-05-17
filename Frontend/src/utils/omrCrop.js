// src/utils/omrCrop.js
// Contour-based sheet detection + perspective warp for OMR images.
// Goal: take a captured photo, find the paper boundary, and warp it to a
// clean rectangle so the AI can read the bubbles with maximum accuracy.

/**
 * Load a base64 data URL into an HTMLImageElement.
 */
export function loadImageFromBase64(base64) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = base64;
  });
}

/**
 * Reorder any 4 points to [TL, TR, BL, BR] regardless of input order.
 * Works on any clockwise/counter-clockwise ordering because we use sum / diff
 * of coordinates rather than index position.
 */
export function reorderFourCorners(points) {
  // points: [{x,y}, {x,y}, {x,y}, {x,y}]
  const withMetrics = points.map(p => ({ x: p.x, y: p.y, s: p.x + p.y, d: p.x - p.y }));
  const sortedBySum = [...withMetrics].sort((a, b) => a.s - b.s);
  const sortedByDiff = [...withMetrics].sort((a, b) => b.d - a.d);
  const tl = sortedBySum[0];
  const br = sortedBySum[3];
  const tr = sortedByDiff[0];
  const bl = sortedByDiff[3];
  return [
    { x: tl.x, y: tl.y },
    { x: tr.x, y: tr.y },
    { x: bl.x, y: bl.y },
    { x: br.x, y: br.y },
  ];
}

/**
 * Auto-detect the largest 4-point contour (most likely the paper/sheet) in an image.
 * @returns {corners: [{x,y}×4] | null} in ORIGINAL image coordinates (not resized)
 *   Order: [TL, TR, BL, BR]
 */
export function detectSheetCorners(cv, imgEl) {
  if (!cv || !imgEl) return null;

  // Draw the image onto a work canvas at a moderate resolution for speed.
  // We operate on a resized copy, then scale corner points back to original coords.
  const ORIG_W = imgEl.naturalWidth || imgEl.width;
  const ORIG_H = imgEl.naturalHeight || imgEl.height;
  if (!ORIG_W || !ORIG_H) return null;

  const WORK_MAX = 1000;
  const scale = Math.min(1, WORK_MAX / Math.max(ORIG_W, ORIG_H));
  const W = Math.round(ORIG_W * scale);
  const H = Math.round(ORIG_H * scale);

  const work = document.createElement("canvas");
  work.width = W;
  work.height = H;
  work.getContext("2d").drawImage(imgEl, 0, 0, W, H);

  let src = null, gray = null, blur = null, edges = null, dilated = null;
  let contours = null, hierarchy = null;
  let bestPoints = null;
  let bestScore = -1;

  try {
    src = cv.imread(work);
    gray = new cv.Mat();
    blur = new cv.Mat();
    edges = new cv.Mat();
    dilated = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    // Slightly larger blur to tolerate paper texture and noise
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 1.5);
    // Canny with low thresholds — we want to catch faint paper edges on light backgrounds
    cv.Canny(blur, edges, 30, 90);
    // Dilate edges so broken lines become continuous (makes contour closing reliable)
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, dilated, kernel);
    kernel.delete();

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = W * H;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < frameArea * 0.10) continue; // sheet must be at least 10% of image

      const peri = cv.arcLength(cnt, true);
      // Try a couple of epsilons to be robust to noise/curvature
      let approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows !== 4) {
        approx.delete();
        approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.03 * peri, true);
      }
      if (approx.rows !== 4) {
        approx.delete();
        approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.05 * peri, true);
      }

      if (approx.rows === 4) {
        const rect = cv.boundingRect(cnt);
        const rectArea = Math.max(1, rect.width * rect.height);
        const extent = area / rectArea; // how well it fills its bounding rect
        const aspect = Math.min(rect.width, rect.height) / Math.max(rect.width, rect.height);

        // Strict-ish filter: must be reasonably rectangular but allow perspective-skewed sheets
        if (extent >= 0.55 && aspect >= 0.35) {
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.intPtr(j, 0)[0], y: approx.intPtr(j, 0)[1] });
          }

          // Ensure corners are distinct
          let minDist = Infinity;
          for (let a = 0; a < 4; a++) {
            for (let b = a + 1; b < 4; b++) {
              const d = Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
              if (d < minDist) minDist = d;
            }
          }
          if (minDist >= 30) {
            const score = area * extent * (0.5 + aspect * 0.5);
            if (score > bestScore) {
              bestScore = score;
              bestPoints = pts;
            }
          }
        }
      }
      approx.delete();
    }
  } finally {
    [src, gray, blur, edges, dilated, contours, hierarchy].forEach(m => {
      try { if (m) m.delete(); } catch {}
    });
  }

  if (!bestPoints) return null;

  // Scale back to original image coordinates
  const invScale = 1 / scale;
  const scaled = bestPoints.map(p => ({ x: p.x * invScale, y: p.y * invScale }));
  return reorderFourCorners(scaled);
}

/**
 * Warp a 4-point quadrilateral in the source image into a rectangular output.
 * Automatically picks a clean output size based on the quad's dimensions.
 * @param corners - Array [TL, TR, BL, BR] in source image coordinates
 * @returns base64 data URL of the warped image (JPEG)
 */
export function warpImageByCorners(cv, imgEl, corners, opts = {}) {
  if (!cv || !imgEl || !corners || corners.length !== 4) return null;

  // Compute natural output size from corner distances, then cap.
  const [tl, tr, bl, br] = corners;
  const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthBot = Math.hypot(br.x - bl.x, br.y - bl.y);
  const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  let outW = Math.round(Math.max(widthTop, widthBot));
  let outH = Math.round(Math.max(heightLeft, heightRight));

  // Clamp so we don't blow up memory on huge photos
  const MAX = opts.maxSize || 1600;
  if (outW > MAX || outH > MAX) {
    const s = MAX / Math.max(outW, outH);
    outW = Math.round(outW * s);
    outH = Math.round(outH * s);
  }
  if (outW < 300) outW = 300;
  if (outH < 300) outH = 300;

  // Draw source into a work canvas at native size
  const src = document.createElement("canvas");
  src.width = imgEl.naturalWidth || imgEl.width;
  src.height = imgEl.naturalHeight || imgEl.height;
  src.getContext("2d").drawImage(imgEl, 0, 0);

  let srcMat = null, dst = null, M = null, srcTri = null, dstTri = null;
  try {
    srcMat = cv.imread(src);
    dst = new cv.Mat();
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      tl.x, tl.y,
      tr.x, tr.y,
      bl.x, bl.y,
      br.x, br.y,
    ]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      outW, 0,
      0, outH,
      outW, outH,
    ]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(srcMat, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    cv.imshow(out, dst);
    return out.toDataURL("image/jpeg", 0.92);
  } finally {
    [srcMat, dst, M, srcTri, dstTri].forEach(m => {
      try { if (m) m.delete(); } catch {}
    });
  }
}

/**
 * One-shot helper: given a base64 image, auto-detect paper corners and return the warped sheet.
 * @returns {cropped: string | null, corners: [{x,y}×4] | null}
 */
export async function autoCropSheet(cv, base64Image) {
  const img = await loadImageFromBase64(base64Image);
  const corners = detectSheetCorners(cv, img);
  if (!corners) return { cropped: null, corners: null };
  const cropped = warpImageByCorners(cv, img, corners);
  return { cropped, corners };
}
