// src/utils/omr.js
// Enhanced for mobile camera support
export function processOMRAndRender(cv, src, outCanvas, {
  questions = 5, 
  choices = 5, 
  answerKey = [1,2,0,2,4],
  checkAutoCapture = false,
  isMobile = false // NEW: Mobile detection flag
} = {}) {
  const W = 700, H = 700;

  // 1) Preprocess with mobile-optimized parameters
  let img = new cv.Mat();
  cv.resize(src, img, new cv.Size(W, H));
  let imgGray = new cv.Mat(), imgBlur = new cv.Mat(), imgCanny = new cv.Mat();
  
  cv.cvtColor(img, imgGray, cv.COLOR_RGBA2GRAY, 0);
  
  // Mobile-optimized blur (stronger for phone camera noise)
  const blurSize = isMobile ? 7 : 5;
  cv.GaussianBlur(imgGray, imgBlur, new cv.Size(blurSize, blurSize), 1.5, 1.5, cv.BORDER_DEFAULT);
  
  // Mobile-optimized edge detection
  const cannyThreshold1 = isMobile ? 20 : 10;
  const cannyThreshold2 = isMobile ? 80 : 70;
  cv.Canny(imgBlur, imgCanny, cannyThreshold1, cannyThreshold2);

  // 2) Enhanced contour detection for mobile
  let contours = new cv.MatVector(), hierarchy = new cv.Mat();
  cv.findContours(imgCanny, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  let best = null;
  let bestScore = -1;
  
  for (let i=0; i<contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    
    // Mobile-optimized area threshold (phones often capture from farther away)
    const minArea = isMobile ? 500 : 1000;
    if (area < minArea) continue;
    
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
    
    if (approx.rows === 4) {
      // Score contours by both area and "squareness"
      const boundingRect = cv.boundingRect(cnt);
      const rectArea = boundingRect.width * boundingRect.height;
      const extent = area / rectArea;
      const aspectRatio = Math.min(boundingRect.width, boundingRect.height) / 
                         Math.max(boundingRect.width, boundingRect.height);
      
      // Combined score favoring large, square-like contours
      const score = area * extent * aspectRatio;
      
      if (score > bestScore) {
        bestScore = score;
        best = { cnt, area, boundingRect };
      }
    }
    approx.delete();
  }
  
  if (!best) {
    cleanup();
    throw new Error(isMobile 
      ? "No sheet detected. Move closer, ensure good lighting, and keep the sheet flat."
      : "No rectangular sheet found. Try a flatter, well-lit photo."
    );
  }

  // 3) Enhanced perspective warp with mobile compensation
  const pts = reorder4(best.cnt, cv);
  const srcTri = cv.matFromArray(4,1,cv.CV_32FC2, pts);
  const dstTri = cv.matFromArray(4,1,cv.CV_32FC2, [0,0, W,0, 0,H, W,H]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  let warped = new cv.Mat();
  cv.warpPerspective(img, warped, M, new cv.Size(W,H));

  // 4) Mobile-optimized thresholding
  let warpGray = new cv.Mat(), thresh = new cv.Mat();
  cv.cvtColor(warped, warpGray, cv.COLOR_RGBA2GRAY, 0);
  
  // Adaptive thresholding for varying mobile lighting conditions
  let thresholdValue = 170;
  if (isMobile) {
    // Calculate average brightness to adapt threshold
    const mean = cv.mean(warpGray);
    thresholdValue = Math.max(150, Math.min(190, mean[0] * 0.7));
  }
  
  cv.threshold(warpGray, thresh, thresholdValue, 255, cv.THRESH_BINARY_INV);

  // 5) Enhanced grid scanning with noise filtering
  const secW = Math.floor(W/choices), secH = Math.floor(H/questions);
  const picked = [];
  const confidenceScores = []; // NEW: Track confidence per question
  
  for (let r=0; r<questions; r++){
    let bestVal = -1, bestIdx = 0;
    let secondBestVal = -1;
    const rowValues = [];
    
    for (let c=0; c<choices; c++){
      const roi = new cv.Rect(c*secW, r*secH, secW, secH);
      const cell = thresh.roi(roi);
      const val = cv.countNonZero(cell);
      rowValues.push(val);
      
      if (val > bestVal) {
        secondBestVal = bestVal;
        bestVal = val;
        bestIdx = c;
      } else if (val > secondBestVal) {
        secondBestVal = val;
      }
      cell.delete();
    }
    
    // Calculate confidence (difference between best and second best)
    const confidence = secondBestVal > 0 ? (bestVal - secondBestVal) / bestVal : 1.0;
    confidenceScores.push(confidence);
    
    // Mobile: require minimum filled pixels to avoid noise
    const minPixels = isMobile ? (secW * secH * 0.05) : (secW * secH * 0.02);
    if (bestVal < minPixels) {
      bestIdx = -1; // No clear selection
    }
    
    picked.push(bestIdx);
  }

  // 6) FIXED: Enhanced grading with proper answer key comparison
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  let totalConfidence = 0;
  const confidentAnswers = [];
  const answerComparison = []; // NEW: Track comparison results

  for (let i = 0; i < questions; i++) {
    // Check if question is answered
    if (picked[i] === -1) {
      unanswered++;
      answerComparison.push({ answered: false, correct: false });
      continue;
    }
    
    // Check if answer matches answer key
    const isCorrect = picked[i] === answerKey[i];
    answerComparison.push({ answered: true, correct: isCorrect });
    
    if (isCorrect) {
      correct++;
    } else {
      wrong++;
    }
    
    totalConfidence += confidenceScores[i];
    confidentAnswers.push(i);
  }

  // FIXED: Calculate score percentage properly
  const scorePct = questions > 0 ? (correct / questions) * 100 : 0;
  const avgConfidence = confidentAnswers.length > 0 ? totalConfidence / confidentAnswers.length : 0;
  const allCorrect = correct === questions;
  
  // Enhanced auto-capture: require good confidence on mobile
  const reliableDetection = isMobile ? avgConfidence > 0.3 : true;

  // 7) Draw with mobile-optimized display
  cv.imshow(outCanvas, warped);
  drawOverlayOnNormalizedCanvas(outCanvas, { 
    W, H, 
    questions, 
    choices, 
    picked, 
    answerKey, 
    scorePct, 
    allCorrect,
    checkAutoCapture,
    isMobile,
    confidenceScores,
    reliableDetection
  });

  function cleanup() {
    [img,imgGray,imgBlur,imgCanny,contours,hierarchy,warped,warpGray,thresh,srcTri,dstTri,M].forEach(m=>{ 
      try{ m.delete() }catch{} 
    });
  }
  cleanup();

  return { 
    scorePct, 
    picked, 
    allCorrect,
    avgConfidence,
    reliableDetection,
    confidenceScores,
    answerComparison,
    correct,
    wrong,
    unanswered // NEW: Return detailed counts for better calculation
  };
}

// Enhanced corner reordering for mobile perspective issues
function reorder4(cnt, cv) {
  const peri = cv.arcLength(cnt, true);
  const approx = new cv.Mat();
  cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
  
  if (approx.rows !== 4) {
    approx.delete();
    throw new Error("Could not find 4 corners for perspective correction");
  }
  
  const pts = [];
  for (let i=0; i<approx.rows; i++) {
    const x = approx.intPtr(i,0)[0], y = approx.intPtr(i,0)[1];
    pts.push({ x, y, s: x + y, d: x - y });
  }
  
  approx.delete();
  
  // More robust sorting with validation
  const sortedBySum = [...pts].sort((a, b) => a.s - b.s);
  const sortedByDiff = [...pts].sort((a, b) => b.d - a.d);
  
  const tl = sortedBySum[0];
  const br = sortedBySum[3];
  const tr = sortedByDiff[0];
  const bl = sortedByDiff[3];
  
  // Validate we have distinct points
  const points = [tl, tr, bl, br];
  const uniquePoints = [...new Set(points.map(p => `${p.x},${p.y}`))];
  
  if (uniquePoints.length !== 4) {
    throw new Error("Invalid corner points detected");
  }
  
  return new Float32Array([tl.x,tl.y, tr.x,tr.y, bl.x,bl.y, br.x,br.y]);
}

// FIXED: Enhanced drawing for mobile display with proper answer key comparison
function drawOverlayOnNormalizedCanvas(canvas, { 
  W, H, 
  questions, 
  choices, 
  picked, 
  answerKey, 
  scorePct, 
  allCorrect = false,
  checkAutoCapture = false,
  isMobile = false,
  confidenceScores = [],
  reliableDetection = true
}) {
  const ctx = canvas.getContext("2d");
  
  // Ensure canvas is exactly W×H so math matches
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; 
    canvas.height = H;
  }

  const secW = Math.floor(W/choices), secH = Math.floor(H/questions);

  // Enhanced background for mobile visibility
  if (allCorrect && checkAutoCapture && reliableDetection) {
    ctx.fillStyle = "rgba(34, 197, 94, 0.1)";
    ctx.fillRect(0, 0, W, H);
  } else if (isMobile && !reliableDetection) {
    ctx.fillStyle = "rgba(255, 165, 0, 0.05)";
    ctx.fillRect(0, 0, W, H);
  }

  // Grid overlay with mobile-optimized styling
  ctx.save();
  ctx.globalAlpha = isMobile ? 0.25 : 0.35;
  ctx.strokeStyle = isMobile ? "#16a34a" : "#22c55e";
  ctx.lineWidth = isMobile ? 1.2 : 1;
  
  // Vertical lines
  for (let i=0; i<=choices; i++){ 
    ctx.beginPath(); 
    ctx.moveTo(i*secW, 0); 
    ctx.lineTo(i*secW, H); 
    ctx.stroke(); 
  }
  
  // Horizontal lines
  for (let j=0; j<=questions; j++){ 
    ctx.beginPath(); 
    ctx.moveTo(0, j*secH); 
    ctx.lineTo(W, j*secH); 
    ctx.stroke(); 
  }
  ctx.restore();

  // FIXED: Enhanced answers overlay with proper answer key comparison
  for (let r = 0; r < questions; r++) {
    if (picked[r] === -1) continue; // Skip unanswered
    
    const cx = (picked[r] * secW) + secW / 2;
    const cy = (r * secH) + secH / 2;
    const isCorrect = answerKey[r] === picked[r]; // Compare with answer key
    const confidence = confidenceScores[r] || 0;
    
    // Size based on confidence (mobile optimization)
    const baseSize = Math.min(secW, secH) / 6;
    const size = isMobile ? baseSize * (0.8 + confidence * 0.4) : baseSize;
    
    ctx.beginPath();
    
    // Color based on correctness and confidence
    let fillColor, strokeColor;
    if (!reliableDetection && isMobile) {
      fillColor = "rgba(255, 165, 0, 0.7)"; // Orange for low confidence
      strokeColor = "rgba(255, 140, 0, 1)";
    } else if (isCorrect) {
      fillColor = `rgba(34, 197, 94, ${0.7 + confidence * 0.3})`; // Green for correct
      strokeColor = "rgba(21, 128, 61, 1)";
    } else {
      fillColor = `rgba(239, 68, 68, ${0.7 + confidence * 0.3})`; // Red for incorrect
      strokeColor = "rgba(185, 28, 28, 1)";
    }
    
    ctx.fillStyle = fillColor;
    ctx.arc(cx, cy, size, 0, Math.PI * 2);
    ctx.fill();
    
    // Border
    ctx.beginPath();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = isMobile ? 2 : 1.5;
    ctx.arc(cx, cy, size, 0, Math.PI * 2);
    ctx.stroke();
    
    // Confidence indicator dot for mobile
    if (isMobile && confidence < 0.5) {
      ctx.beginPath();
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.arc(cx + size * 0.6, cy - size * 0.6, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // NEW: Add X mark for incorrect answers for better visibility
    if (!isCorrect && reliableDetection) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = isMobile ? 2 : 1.5;
      const crossSize = size * 0.6;
      ctx.moveTo(cx - crossSize, cy - crossSize);
      ctx.lineTo(cx + crossSize, cy + crossSize);
      ctx.moveTo(cx + crossSize, cy - crossSize);
      ctx.lineTo(cx - crossSize, cy + crossSize);
      ctx.stroke();
    }
  }

  // Enhanced bottom band for mobile
  const bottomBandHeight = isMobile ? 60 : 54;
  
  // Dynamic background
  if (allCorrect && checkAutoCapture && reliableDetection) {
    ctx.fillStyle = "rgba(34, 197, 94, 0.9)";
  } else if (isMobile && !reliableDetection) {
    ctx.fillStyle = "rgba(255, 165, 0, 0.9)";
  } else {
    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  }
  
  ctx.fillRect(0, H - bottomBandHeight, W, bottomBandHeight);
  
  // Score text with mobile-optimized sizing
  ctx.fillStyle = "#fff";
  const scoreFontSize = isMobile ? 18 : 20;
  ctx.font = `bold ${scoreFontSize}px system-ui, -apple-system, sans-serif`;
  
  // FIXED: Always show score even if 0%
  ctx.fillText(`Score: ${scorePct.toFixed(1)}%`, 16, H - (isMobile ? 25 : 20));
  
  // Answers text
  const answersFontSize = isMobile ? 12 : 14;
  ctx.font = `${answersFontSize}px system-ui, -apple-system, sans-serif`;
  
  let answersColor = "#cbd5e1";
  if (allCorrect && checkAutoCapture) answersColor = "#e0f2fe";
  if (isMobile && !reliableDetection) answersColor = "#ffedd5";
  
  ctx.fillStyle = answersColor;
  ctx.fillText(`Answers: [${picked.join(", ")}]`, 160, H - (isMobile ? 25 : 20));
  
  // Mobile-specific indicators
  if (isMobile) {
    if (!reliableDetection) {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 14px system-ui, -apple-system, sans-serif";
      ctx.fillText("⚠️ Low Confidence", W - 140, H - 25);
    } else if (allCorrect && checkAutoCapture) {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 16px system-ui, -apple-system, sans-serif";
      ctx.fillText("✅ Ready", W - 100, H - 25);
    }
    
    // Confidence indicator
    const avgConfidence = confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length;
    if (avgConfidence > 0) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.font = "10px system-ui, -apple-system, sans-serif";
      ctx.fillText(`Confidence: ${Math.round(avgConfidence * 100)}%`, W - 120, H - 10);
    }
  }
}

// NEW: Mobile device detection utility
export function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
         (navigator.maxTouchPoints && navigator.maxTouchPoints > 2);
}

// NEW: Mobile-optimized camera constraints
export function getMobileCameraConstraints() {
  const isMobile = isMobileDevice();
  
  return {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: isMobile ? 1280 : 1920 },
      height: { ideal: isMobile ? 720 : 1080 },
      frameRate: { ideal: isMobile ? 24 : 30 }
    },
    audio: false
  };
}