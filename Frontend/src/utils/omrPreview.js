// src/utils/omrPreview.js
// OpenCV-based real-time OMR sheet detection for camera preview.
// STRICT detection — only triggers on actual OMR sheets, not faces/random objects.

/**
 * Detect OMR sheet in a video frame, draw contours and bubble highlights.
 * Returns detection status for auto-pause logic.
 */
export function detectOMRSheet(cv, src, outCanvas, { questions = 5, choices = 5 } = {}) {
  const W = 700, H = 700;
  const TOTAL_AREA = W * H; // 490000

  // 1) Resize
  let img = new cv.Mat();
  cv.resize(src, img, new cv.Size(W, H));

  // 2) Grayscale + blur + edge detection
  let gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat();
  cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY, 0);
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 1.5);
  cv.Canny(blur, edges, 40, 100);

  // 3) Find the OMR sheet — strict validation
  let contours = new cv.MatVector(), hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let bestContour = null;
  let bestScore = -1;

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);

    // STRICT: Sheet must be at least 15% of the frame area
    if (area < TOTAL_AREA * 0.15) continue;

    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

    if (approx.rows === 4) {
      const rect = cv.boundingRect(cnt);
      const extent = area / (rect.width * rect.height); // how rectangular (1.0 = perfect)
      const aspect = Math.min(rect.width, rect.height) / Math.max(rect.width, rect.height);

      // STRICT: Must be reasonably rectangular (extent > 0.7) and roughly square-ish (aspect > 0.4)
      if (extent < 0.7 || aspect < 0.4) {
        approx.delete();
        continue;
      }

      // STRICT: All 4 corners must be distinct (not degenerate)
      const points = [];
      for (let j = 0; j < 4; j++) {
        points.push({ x: approx.intPtr(j, 0)[0], y: approx.intPtr(j, 0)[1] });
      }
      const minDist = Math.min(
        ...points.flatMap((p, idx) =>
          points.slice(idx + 1).map(q => Math.hypot(p.x - q.x, p.y - q.y))
        )
      );
      // Corners must be at least 50px apart
      if (minDist < 50) {
        approx.delete();
        continue;
      }

      const score = area * extent * aspect;
      if (score > bestScore) {
        bestScore = score;
        if (bestContour) bestContour.approx.delete();
        bestContour = { cnt, approx, area, rect };
      } else {
        approx.delete();
      }
    } else {
      approx.delete();
    }
  }

  let detected = false;
  let bubbleCount = 0;
  let confidence = 0;
  let cleanImageBase64 = null;

  if (bestContour) {
    // 4) Perspective warp
    const pts = reorder4Points(bestContour.approx);
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, pts);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, 0, H, W, H]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    let warped = new cv.Mat();
    cv.warpPerspective(img, warped, M, new cv.Size(W, H));

    // 5) Threshold the warped sheet
    let warpGray = new cv.Mat(), thresh = new cv.Mat();
    cv.cvtColor(warped, warpGray, cv.COLOR_RGBA2GRAY, 0);
    cv.threshold(warpGray, thresh, 170, 255, cv.THRESH_BINARY_INV);

    // 6) Scan grid for filled bubbles — STRICT validation
    const secW = Math.floor(W / choices);
    const secH = Math.floor(H / questions);
    const cellArea = secW * secH;
    const detectedBubbles = [];

    for (let r = 0; r < questions; r++) {
      let bestVal = -1, bestIdx = -1;
      let secondBest = -1;
      const rowVals = [];

      for (let c = 0; c < choices; c++) {
        const roi = new cv.Rect(c * secW, r * secH, secW, secH);
        const cell = thresh.roi(roi);
        const val = cv.countNonZero(cell);
        cell.delete();
        rowVals.push(val);

        if (val > bestVal) {
          secondBest = bestVal;
          bestVal = val;
          bestIdx = c;
        } else if (val > secondBest) {
          secondBest = val;
        }
      }

      // Bubble validation:
      // 1. Best must have at least 5% filled pixels (a real darkened bubble)
      // 2. Best must be at least 1.5x the second best (clear separation)
      const minFill = cellArea * 0.05;
      const separation = secondBest > 0 ? bestVal / secondBest : 999;

      if (bestVal > minFill && separation >= 1.5 && bestIdx >= 0) {
        const conf = (bestVal - secondBest) / bestVal;
        detectedBubbles.push({ row: r, col: bestIdx, confidence: conf });
        bubbleCount++;
      }
    }

    confidence = bubbleCount / questions;

    // Only detect when ALL bubbles are found (100%)
    detected = bubbleCount === questions;

    // 7) Save CLEAN warped image (no overlay) for AI scanning
    const cleanCanvas = document.createElement("canvas");
    cleanCanvas.width = W; cleanCanvas.height = H;
    cv.imshow(cleanCanvas, warped);
    cleanImageBase64 = cleanCanvas.toDataURL("image/jpeg", 0.92);

    // 8) Draw preview on canvas (with overlays for the user)
    cv.imshow(outCanvas, warped);
    const ctx = outCanvas.getContext("2d");
    if (outCanvas.width !== W || outCanvas.height !== H) {
      outCanvas.width = W;
      outCanvas.height = H;
    }

    // Draw grid lines
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 1;
    for (let i = 0; i <= choices; i++) {
      ctx.beginPath(); ctx.moveTo(i * secW, 0); ctx.lineTo(i * secW, H); ctx.stroke();
    }
    for (let j = 0; j <= questions; j++) {
      ctx.beginPath(); ctx.moveTo(0, j * secH); ctx.lineTo(W, j * secH); ctx.stroke();
    }
    ctx.restore();

    // Highlight detected bubbles
    for (const b of detectedBubbles) {
      const cx = b.col * secW + secW / 2;
      const cy = b.row * secH + secH / 2;
      const radius = Math.min(secW, secH) / 5;

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = detected
        ? `rgba(34, 197, 94, ${0.4 + b.confidence * 0.4})`
        : `rgba(251, 191, 36, ${0.4 + b.confidence * 0.4})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = detected ? "rgba(21, 128, 61, 0.8)" : "rgba(180, 130, 0, 0.8)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Bottom status band
    const bandH = 48;
    ctx.fillStyle = detected ? "rgba(34, 197, 94, 0.9)" : "rgba(251, 191, 36, 0.9)";
    ctx.fillRect(0, H - bandH, W, bandH);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(
      detected
        ? `Sheet Detected — ${bubbleCount}/${questions} bubbles found`
        : `Scanning... ${bubbleCount}/${questions} bubbles`,
      16, H - bandH / 2
    );

    if (detected) {
      ctx.textAlign = "right";
      ctx.font = "bold 14px system-ui";
      ctx.fillText("Ready to Scan", W - 16, H - bandH / 2);
    }

    // Cleanup warped mats
    [warped, warpGray, thresh, srcPts, dstPts, M].forEach(m => { try { m.delete(); } catch {} });
    bestContour.approx.delete();
  } else {
    // No sheet found — show raw frame with guidance message
    cv.imshow(outCanvas, img);
    const ctx = outCanvas.getContext("2d");
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#fff";
    ctx.font = "bold 20px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Position the OMR sheet in frame", W / 2, H / 2 - 20);
    ctx.font = "14px system-ui";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText("Hold the sheet flat, ensure good lighting", W / 2, H / 2 + 15);

    const bandH = 48;
    ctx.fillStyle = "rgba(239, 68, 68, 0.85)";
    ctx.fillRect(0, H - bandH, W, bandH);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("No OMR sheet detected", 16, H - bandH / 2);
  }

  // Cleanup
  [img, gray, blur, edges, contours, hierarchy].forEach(m => { try { m.delete(); } catch {} });

  return { detected, bubbleCount, confidence, cleanImageBase64 };
}

/** Reorder 4 approx points to [TL, TR, BL, BR] */
function reorder4Points(approx) {
  const pts = [];
  for (let i = 0; i < approx.rows; i++) {
    const x = approx.intPtr(i, 0)[0];
    const y = approx.intPtr(i, 0)[1];
    pts.push({ x, y, s: x + y, d: x - y });
  }
  const sortedBySum = [...pts].sort((a, b) => a.s - b.s);
  const sortedByDiff = [...pts].sort((a, b) => b.d - a.d);
  const tl = sortedBySum[0], br = sortedBySum[3];
  const tr = sortedByDiff[0], bl = sortedByDiff[3];
  return new Float32Array([tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y]);
}
