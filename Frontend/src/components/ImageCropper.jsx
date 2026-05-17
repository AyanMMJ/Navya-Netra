// src/components/ImageCropper.jsx
// 4-corner perspective crop: user drags four draggable handles to define the
// paper boundary, then we warp the quad to a rectangle using OpenCV.js.
//
// Works on both mouse and touch (phones/tablets).

import { useEffect, useRef, useState, useCallback } from "react";
import { warpImageByCorners, detectSheetCorners, loadImageFromBase64 } from "../utils/omrCrop.js";

const HANDLE_RADIUS = 14;

export default function ImageCropper({ open, image, onCancel, onApply }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [imgEl, setImgEl] = useState(null);
  const [corners, setCorners] = useState(null); // [{x,y}×4] in canvas coords, order: TL, TR, BL, BR
  const [draggingIdx, setDraggingIdx] = useState(-1);
  const [scale, setScale] = useState(1); // display-to-original ratio
  const [dims, setDims] = useState({ w: 0, h: 0 }); // display dims
  const [cvReady, setCvReady] = useState(false);
  const [busy, setBusy] = useState(false);

  // Wait for OpenCV
  useEffect(() => {
    if (!open) return;
    const iv = setInterval(() => {
      if (window.cv && window.cv.getBuildInformation) {
        setCvReady(true);
        clearInterval(iv);
      }
    }, 150);
    return () => clearInterval(iv);
  }, [open]);

  // Load the image and set up canvas + auto-detected initial corners
  useEffect(() => {
    if (!open || !image) return;
    let cancelled = false;

    loadImageFromBase64(image).then(img => {
      if (cancelled) return;
      setImgEl(img);

      // Fit canvas to the wrapping container width
      const wrap = wrapRef.current;
      const containerW = wrap?.clientWidth || 600;
      const maxH = Math.min(window.innerHeight * 0.6, 700);
      const natW = img.naturalWidth;
      const natH = img.naturalHeight;
      const s = Math.min(containerW / natW, maxH / natH, 1);
      const dw = Math.round(natW * s);
      const dh = Math.round(natH * s);

      setScale(s);
      setDims({ w: dw, h: dh });

      // Try auto-detect for initial corners — fall back to a sensible default rectangle
      let detected = null;
      if (window.cv && window.cv.getBuildInformation) {
        try {
          detected = detectSheetCorners(window.cv, img);
        } catch (e) {
          console.warn("auto-detect failed in cropper:", e);
        }
      }

      let initial;
      if (detected) {
        initial = detected.map(p => ({ x: p.x * s, y: p.y * s }));
      } else {
        const pad = 0.06;
        initial = [
          { x: dw * pad, y: dh * pad },
          { x: dw * (1 - pad), y: dh * pad },
          { x: dw * pad, y: dh * (1 - pad) },
          { x: dw * (1 - pad), y: dh * (1 - pad) },
        ];
      }
      setCorners(initial);
    });

    return () => { cancelled = true; };
  }, [open, image, cvReady]);

  // Draw image + quad + handles whenever state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgEl || !corners) return;
    canvas.width = dims.w;
    canvas.height = dims.h;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, dims.w, dims.h);
    ctx.drawImage(imgEl, 0, 0, dims.w, dims.h);

    // Darken outside the quad
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, dims.w, dims.h);

    // Cut out the quad area using "destination-out" by drawing a clear polygon
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    // Order around the quad: TL -> TR -> BR -> BL
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Redraw image inside the quad (cleaner look than relying on composite math)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(imgEl, 0, 0, dims.w, dims.h);
    ctx.restore();

    // Draw quad outline
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.closePath();
    ctx.stroke();

    // Draw handles
    const labels = ["TL", "TR", "BL", "BR"];
    corners.forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = "#065f46";
      ctx.font = "bold 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(labels[i], c.x, c.y);
    });
  }, [imgEl, corners, dims]);

  const pointerToCanvas = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }, []);

  const findCornerAt = useCallback((x, y) => {
    if (!corners) return -1;
    // Pick whichever corner is closest within handle radius + a little slack
    let best = -1;
    let bestDist = HANDLE_RADIUS * 1.8;
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(corners[i].x - x, corners[i].y - y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }, [corners]);

  const onPointerDown = (e) => {
    e.preventDefault();
    const t = e.touches ? e.touches[0] : e;
    const { x, y } = pointerToCanvas(t.clientX, t.clientY);
    const idx = findCornerAt(x, y);
    if (idx >= 0) setDraggingIdx(idx);
  };

  const onPointerMove = (e) => {
    if (draggingIdx < 0) return;
    e.preventDefault();
    const t = e.touches ? e.touches[0] : e;
    const { x, y } = pointerToCanvas(t.clientX, t.clientY);
    setCorners(prev => {
      const next = [...prev];
      next[draggingIdx] = {
        x: Math.max(0, Math.min(dims.w, x)),
        y: Math.max(0, Math.min(dims.h, y)),
      };
      return next;
    });
  };

  const onPointerUp = () => setDraggingIdx(-1);

  const handleAutoDetect = () => {
    if (!imgEl || !window.cv) return;
    try {
      const detected = detectSheetCorners(window.cv, imgEl);
      if (!detected) {
        alert("Could not auto-detect a sheet. Try manual adjustment.");
        return;
      }
      setCorners(detected.map(p => ({ x: p.x * scale, y: p.y * scale })));
    } catch (e) {
      alert("Auto-detect failed: " + e.message);
    }
  };

  const handleReset = () => {
    if (!dims.w || !dims.h) return;
    const pad = 0.06;
    setCorners([
      { x: dims.w * pad, y: dims.h * pad },
      { x: dims.w * (1 - pad), y: dims.h * pad },
      { x: dims.w * pad, y: dims.h * (1 - pad) },
      { x: dims.w * (1 - pad), y: dims.h * (1 - pad) },
    ]);
  };

  const handleApply = async () => {
    if (!imgEl || !corners || !window.cv) return;
    setBusy(true);
    try {
      // Convert display-space corners back to original image coords
      const origCorners = corners.map(c => ({ x: c.x / scale, y: c.y / scale }));
      const cropped = warpImageByCorners(window.cv, imgEl, origCorners);
      if (!cropped) {
        alert("Could not crop image. Check corner positions.");
        return;
      }
      onApply(cropped);
    } catch (e) {
      alert("Crop failed: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 overflow-y-auto"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-3xl bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[95vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-white">
          <h3 className="text-base sm:text-lg font-semibold">Crop OMR Sheet — drag corners</h3>
          <button
            className="w-8 h-8 rounded-lg border hover:bg-gray-100 text-gray-600"
            onClick={onCancel}
            aria-label="Close"
          >✕</button>
        </div>

        <div className="p-3 sm:p-4 overflow-y-auto flex-1">
          <p className="text-xs sm:text-sm text-gray-600 mb-3">
            Drag the four green handles (TL / TR / BL / BR) to the corners of the OMR sheet. The darkened area will be cropped out. Tap <b>Auto-Detect</b> to let OpenCV find the sheet edges automatically.
          </p>

          <div ref={wrapRef} className="relative w-full flex items-center justify-center bg-gray-900 rounded-lg overflow-hidden">
            {!cvReady ? (
              <div className="py-20 text-white text-sm">Loading OpenCV…</div>
            ) : (
              <canvas
                ref={canvasRef}
                onMouseDown={onPointerDown}
                onMouseMove={onPointerMove}
                onMouseUp={onPointerUp}
                onMouseLeave={onPointerUp}
                onTouchStart={onPointerDown}
                onTouchMove={onPointerMove}
                onTouchEnd={onPointerUp}
                style={{ width: dims.w, height: dims.h, touchAction: "none", cursor: draggingIdx >= 0 ? "grabbing" : "grab" }}
              />
            )}
          </div>
        </div>

        <div className="px-3 sm:px-4 py-3 border-t bg-gray-50 flex flex-wrap gap-2 justify-between">
          <div className="flex gap-2 flex-wrap">
            <button
              className="px-3 py-2 rounded-lg border text-sm font-medium hover:bg-gray-100 disabled:opacity-50"
              onClick={handleAutoDetect}
              disabled={!cvReady || busy}
            >
              ✨ Auto-Detect
            </button>
            <button
              className="px-3 py-2 rounded-lg border text-sm font-medium hover:bg-gray-100 disabled:opacity-50"
              onClick={handleReset}
              disabled={!cvReady || busy}
            >
              ↺ Reset
            </button>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              className="px-4 py-2 rounded-lg border-2 border-gray-300 text-sm font-semibold hover:bg-gray-100"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-semibold shadow disabled:opacity-50"
              onClick={handleApply}
              disabled={!cvReady || busy || !corners}
            >
              {busy ? "Cropping…" : "✓ Apply Crop"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
