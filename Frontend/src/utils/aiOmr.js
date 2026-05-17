// src/utils/aiOmr.js — AI-powered OMR scanning via backend API

/**
 * Convert a canvas element to a base64 JPEG data URL
 */
export function canvasToBase64(canvas, quality = 0.85) {
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Convert an HTMLImageElement to a base64 JPEG data URL
 */
export function imageToBase64(img, maxWidth = 1500) {
  const canvas = document.createElement("canvas");
  const scale = img.width > maxWidth ? maxWidth / img.width : 1;
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * Convert a video element's current frame to base64 JPEG
 */
export function videoFrameToBase64(video, maxWidth = 1500) {
  const canvas = document.createElement("canvas");
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = vw > maxWidth ? maxWidth / vw : 1;
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * Send an OMR image to the AI backend for scanning
 * @param {string} base64Image - Base64 data URL of the OMR sheet
 * @param {number} questions - Number of questions on the sheet
 * @param {number} choices - Number of answer choices per question (default 5)
 * @returns {Promise<{answers: number[], confidence: number[], notes: string}>}
 */
export async function scanOMRWithAI(base64Image, questions = 5, choices = 5) {
  const response = await fetch("/api/scan-omr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: base64Image,
      questions,
      choices,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `Server error: ${response.status}`);
  }

  return response.json();
}

/**
 * Grade the AI-detected answers against the answer key
 * @param {number[]} detected - AI-detected answers (0-based indices, -1 for unanswered)
 * @param {number[]} answerKey - Correct answer key (0-based indices)
 * @returns {Object} Grading results
 */
export function gradeAnswers(detected, answerKey) {
  const questions = Math.max(detected.length, answerKey.length);
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  const answerComparison = [];

  for (let i = 0; i < questions; i++) {
    const pick = detected[i] ?? -1;
    const key = answerKey[i] ?? -1;

    if (pick === -1) {
      unanswered++;
      answerComparison.push({ answered: false, correct: false });
    } else if (pick === key) {
      correct++;
      answerComparison.push({ answered: true, correct: true });
    } else {
      wrong++;
      answerComparison.push({ answered: true, correct: false });
    }
  }

  const scorePct = questions > 0 ? (correct / questions) * 100 : 0;

  return {
    scorePct,
    correct,
    wrong,
    unanswered,
    answerComparison,
    allCorrect: correct === questions,
  };
}

/**
 * Draw the result overlay on a canvas showing the OMR image.
 * Marks each question's filled bubble (red = wrong, green = correct) and
 * highlights the correct answer beside a wrong one.
 *
 * Geometry comes from `layout` (the OpenCV layout detector) when available —
 * this supports any single/multi-column sheet. Otherwise it falls back to a
 * uniform `questions` x `choices` grid.
 */
export function drawAIResultOverlay(canvas, {
  imageSource,        // img element or canvas with the OMR image
  picked,             // detected answer per question (0-based, -1 = blank)
  answerKey,          // correct answer per question
  confidence = [],
  layout,             // {questions:[{bubbles:[{x,y}]}], radius} from detectOMRLayout
  questions,          // fallback only: question count
  choices = 5,        // fallback only: choices per question
}) {
  const W = 700, H = 700;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Draw the original image scaled to canvas
  if (imageSource) {
    ctx.drawImage(imageSource, 0, 0, W, H);
  } else {
    ctx.fillStyle = "#f8f9fa";
    ctx.fillRect(0, 0, W, H);
  }

  // Semi-transparent overlay for contrast
  ctx.fillStyle = "rgba(0, 0, 0, 0.34)";
  ctx.fillRect(0, 0, W, H);

  // Build a per-question list of choice-bubble centres (in canvas pixels).
  let qBubbles; // qBubbles[i] = [{x,y}, ...] one entry per choice
  let radius;
  const hasLayout = layout && Array.isArray(layout.questions) && layout.questions.length;

  if (hasLayout) {
    qBubbles = layout.questions.map((q) =>
      q.bubbles.map((b) => ({ x: b.x * W, y: b.y * H })),
    );
    radius = Math.max(7, (layout.radius || 0.03) * W * 0.95);
  } else {
    // Fallback: uniform grid over the whole canvas.
    const Q = Math.max(1, questions || picked.length || 1);
    const C = Math.max(2, choices || 5);
    const secW = W / C, secH = H / Q;
    qBubbles = [];
    for (let r = 0; r < Q; r++) {
      const row = [];
      for (let c = 0; c < C; c++) {
        row.push({ x: c * secW + secW / 2, y: r * secH + secH / 2 });
      }
      qBubbles.push(row);
    }
    radius = Math.max(9, Math.min(secW, secH) / 4);
  }

  // Draw one circular marker on a bubble.
  function drawMarker(x, y, kind, glyph, conf = 1) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (kind === "wrong") {
      ctx.fillStyle = `rgba(239, 68, 68, ${0.78 + conf * 0.22})`;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(153, 27, 27, 1)";
      ctx.stroke();
    } else if (kind === "correct") {
      ctx.fillStyle = `rgba(34, 197, 94, ${0.78 + conf * 0.22})`;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(21, 128, 61, 1)";
      ctx.stroke();
    } else {
      // "key" — the correct answer the student should have marked.
      ctx.fillStyle = "rgba(34, 197, 94, 0.55)";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(21, 128, 61, 1)";
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.max(9, Math.round(radius * 1.05))}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, x, y);
    ctx.restore();
  }

  // Faint ring on every detected bubble (shows what was located).
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  for (const row of qBubbles) {
    for (const b of row) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Draw answer indicators per question
  let correctCount = 0;
  for (let i = 0; i < qBubbles.length; i++) {
    const bubbles = qBubbles[i];
    const C = bubbles.length;
    const rawPick = picked[i];
    const pick = (rawPick == null) ? -1 : rawPick;
    const keyIdx = (answerKey[i] == null) ? -1 : answerKey[i];
    const isCorrect = pick !== -1 && pick === keyIdx;
    const isWrong = pick !== -1 && pick !== keyIdx;
    const conf = confidence[i] || 0.5;
    if (isCorrect) correctCount += 1;

    if (pick === -1) {
      // Unanswered — still show the correct answer in green.
      if (keyIdx >= 0 && keyIdx < C) {
        drawMarker(bubbles[keyIdx].x, bubbles[keyIdx].y, "key", "✓");
      }
      const f = bubbles[0];
      ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
      ctx.font = `bold ${Math.max(12, Math.round(radius * 1.4))}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", f.x - radius * 2.3, f.y);
      continue;
    }

    // The bubble the student actually filled.
    if (pick >= 0 && pick < C) {
      drawMarker(bubbles[pick].x, bubbles[pick].y,
        isCorrect ? "correct" : "wrong", isCorrect ? "✓" : "✗", conf);
    }

    // If wrong, highlight the correct answer in green beside it.
    if (isWrong && keyIdx >= 0 && keyIdx < C) {
      drawMarker(bubbles[keyIdx].x, bubbles[keyIdx].y, "key", "✓");
    }
  }

  // Bottom band with score
  const total = qBubbles.length || 1;
  const scorePct = (correctCount / total) * 100;
  const bottomH = 54;
  ctx.fillStyle = scorePct >= 80 ? "rgba(34, 197, 94, 0.9)" :
                  scorePct >= 40 ? "rgba(59, 130, 246, 0.9)" :
                  "rgba(239, 68, 68, 0.9)";
  ctx.fillRect(0, H - bottomH, W, bottomH);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 20px system-ui";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`Score: ${scorePct.toFixed(1)}%`, 16, H - bottomH / 2);

  ctx.font = "13px system-ui";
  const info = hasLayout
    ? `${total} questions · ${layout.meta?.choices ?? "?"} choices` +
      `${layout.meta?.columns > 1 ? ` · ${layout.meta.columns} columns` : ""}`
    : `Detected: ${total} questions`;
  ctx.fillText(info, 150, H - bottomH / 2);

  ctx.textAlign = "right";
  ctx.font = "bold 12px system-ui";
  ctx.fillText("Powered by AI Vision", W - 16, H - bottomH / 2);
}

/**
 * Extract questions from a question paper (image, Word doc, or text)
 * @param {Object} params
 * @param {string} [params.image] - Base64 data URL for images
 * @param {string} [params.fileData] - Base64 data for Word docs
 * @param {string} [params.fileType] - "docx", "doc", "image"
 * @param {string} [params.text] - Plain text of questions
 * @returns {Promise<{questions: Array, subject: string, totalQuestions: number}>}
 */
export async function extractQuestions({ image, fileData, fileType, text } = {}) {
  const response = await fetch("/api/extract-questions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, fileData, fileType, text }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `Server error: ${response.status}`);
  }

  return response.json();
}

/**
 * Read a file as base64 data URL
 */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Evaluate answer sheet(s) against extracted questions.
 * All images/files are sent together so the AI sees the complete answer sheet.
 * @param {Object} params
 * @param {string[]} [params.images] - Array of base64 image data URLs (all pages)
 * @param {Array<{fileData: string, fileType: string}>} [params.files] - Array of doc/PDF files
 * @param {Array<{number: string, text: string}>} questions - Extracted questions
 * @returns {Promise<Object>} Accuracy results per answer
 */
export async function evaluateTheoryPaper({ images, files } = {}, questions) {
  const response = await fetch("/api/evaluate-theory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images, files, questions }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `Server error: ${response.status}`);
  }

  return response.json();
}

/**
 * Check if AI backend is available
 */
export async function checkAIBackend() {
  try {
    const res = await fetch("/api/health", { method: "GET" });
    if (!res.ok) return { available: false, reason: "Server not responding" };
    const data = await res.json();
    return {
      available: true,
      aiConfigured: data.ai,
      reason: data.ai ? "Ready" : "API key not set",
    };
  } catch {
    return { available: false, reason: "Backend server not running. Start it with: npm run server" };
  }
}
