// server.js — Express backend for AI-powered OMR scanning
// Supports: Groq (free), Gemini (free), OpenAI (paid)
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import mammoth from "mammoth";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ===== Detect which AI provider is configured =====
function getProvider() {
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

// Health check
app.get("/health", (_req, res) => {
  const provider = getProvider();
  res.json({ status: "ok", ai: !!provider, provider: provider || "none" });
});

// ===== Shared prompt builder =====
function buildPrompt(numQuestions, numChoices) {
  const choiceLabels = ["A", "B", "C", "D", "E"].slice(0, numChoices);
  return `You are an expert OMR (Optical Mark Recognition) sheet reader. Analyze this image of a filled OMR/bubble answer sheet with MAXIMUM accuracy.

TASK: Identify the marked/filled bubble for each question row.

SHEET FORMAT:
- The sheet has ${numQuestions} questions (rows), numbered 1 to ${numQuestions}
- Each question has ${numChoices} choices: ${choiceLabels.join(", ")} (indices ${Array.from({ length: numChoices }, (_, i) => i).join(", ")})
- A filled/darkened/shaded bubble indicates the selected answer
- An empty/unfilled bubble means that choice was NOT selected
- Sheets vary — they may have 10, 50, 100 or more questions arranged in single or multiple columns. Read them in natural reading order (left to right across columns, top to bottom).

INSTRUCTIONS — FOLLOW STEP BY STEP:
1. First, locate the question numbers on the sheet (they are usually printed next to each row of bubbles).
2. For EACH question from 1 to ${numQuestions}, find its row of ${numChoices} bubbles.
3. Compare the darkness of all ${numChoices} bubbles in that row. The MOST darkened one is the student's answer.
4. Output the 0-based index of the darkest bubble (A=0, B=1, C=2, D=3, E=4).
5. If a row has NO bubble that is clearly darker than the others (all empty), use -1.
6. If a row has multiple equally-dark marks, pick the one most completely filled. If truly ambiguous, use -1.
7. Ignore stray marks, eraser smudges, printed text, and borders — only actual bubble fills count.
8. Do NOT infer answers based on a hypothetical "correct" answer — only report what is actually marked.

QUALITY CHECKS:
- Your "answers" array MUST have EXACTLY ${numQuestions} entries, one per question in order.
- Double-check question numbering if multi-column: go down column 1 first, then column 2, etc., but always match the printed question number.

Respond with ONLY a valid JSON object in this exact format, no other text.
Keep it compact — do NOT add extra fields or explanations:
{
  "answers": [<array of EXACTLY ${numQuestions} integers, each 0-${numChoices - 1} or -1>],
  "confidence": [<array of EXACTLY ${numQuestions} floats from 0.0 to 1.0>],
  "notes": "<one short sentence about image quality>"
}`;
}

// ===== Shared response parser =====
function parseAIResponse(rawResponse, numQuestions, numChoices) {
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in AI response");

  const parsed = JSON.parse(jsonMatch[0]);

  const answers = Array.isArray(parsed.answers)
    ? parsed.answers.map((a) => {
        const num = parseInt(a);
        return (isNaN(num) || num < -1 || num >= numChoices) ? -1 : num;
      })
    : Array(numQuestions).fill(-1);

  while (answers.length < numQuestions) answers.push(-1);
  if (answers.length > numQuestions) answers.length = numQuestions;

  const confidence = Array.isArray(parsed.confidence)
    ? parsed.confidence.map((c) => Math.max(0, Math.min(1, parseFloat(c) || 0)))
    : Array(numQuestions).fill(0.5);

  while (confidence.length < numQuestions) confidence.push(0.5);
  if (confidence.length > numQuestions) confidence.length = numQuestions;

  // Four corner bubble centers (fractions 0-1). Null if not reliably reported;
  // the client then falls back to a uniform full-image grid.
  const asPoint = (p) => {
    if (!p || typeof p !== "object") return null;
    const x = parseFloat(p.x);
    const y = parseFloat(p.y);
    if (isNaN(x) || isNaN(y)) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  };
  let bubbleGrid = null;
  const g = parsed.bubbleGrid;
  if (g && typeof g === "object") {
    const tl = asPoint(g.topLeft);
    const tr = asPoint(g.topRight);
    const bl = asPoint(g.bottomLeft);
    const br = asPoint(g.bottomRight);
    if (tl && tr && bl && br) {
      // Sanity: the matrix should have real width and height.
      const wide = Math.abs(tr.x - tl.x) > 0.03 || Math.abs(br.x - bl.x) > 0.03;
      const tall = Math.abs(bl.y - tl.y) > 0.03 || Math.abs(br.y - tr.y) > 0.03;
      if (wide && tall) {
        bubbleGrid = { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br };
      }
    }
  }

  return { answers, confidence, bubbleGrid, notes: parsed.notes || "" };
}

// ===== Extract base64 data from data URL =====
function extractBase64(image) {
  if (image.startsWith("data:")) {
    const match = image.match(/^data:(.+?);base64,(.+)$/s);
    if (match) return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: "image/jpeg", data: image };
}

// ===== Provider-specific scan functions =====

async function scanWithGroq(image, numQuestions, numChoices) {
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });

  const imageUrl = image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
  const prompt = buildPrompt(numQuestions, numChoices);

  const response = await client.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: Math.max(2000, numQuestions * 30),
    temperature: 0.1,
  });

  const raw = response.choices[0]?.message?.content || "";
  console.log("Groq Raw Response:", raw);
  return { ...parseAIResponse(raw, numQuestions, numChoices), model: "llama-4-scout (Groq)" };
}

async function scanWithGemini(image, numQuestions, numChoices) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = buildPrompt(numQuestions, numChoices);
  const { mimeType, data } = extractBase64(image);

  const result = await model.generateContent([
    prompt,
    { inlineData: { mimeType, data } },
  ]);

  const raw = result.response.text();
  console.log("Gemini Raw Response:", raw);
  return { ...parseAIResponse(raw, numQuestions, numChoices), model: "gemini-2.0-flash" };
}

async function scanWithOpenAI(image, numQuestions, numChoices) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const imageUrl = image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
  const prompt = buildPrompt(numQuestions, numChoices);

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
        ],
      },
    ],
    max_tokens: Math.max(2000, numQuestions * 30),
    temperature: 0.1,
  });

  const raw = response.choices[0]?.message?.content || "";
  console.log("OpenAI Raw Response:", raw);
  return { ...parseAIResponse(raw, numQuestions, numChoices), model: "gpt-4o" };
}

// ===== Route a scan to the active provider =====
async function scanOMR(image, questions, choices = 5) {
  const provider = getProvider();
  const numQuestions = parseInt(questions) || 5;
  const numChoices = parseInt(choices) || 5;

  switch (provider) {
    case "groq":   return scanWithGroq(image, numQuestions, numChoices);
    case "gemini": return scanWithGemini(image, numQuestions, numChoices);
    case "openai": return scanWithOpenAI(image, numQuestions, numChoices);
    default:
      throw new Error("No AI provider configured. Set GROQ_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY in .env");
  }
}

// ===== Main endpoint =====
app.post("/scan-omr", async (req, res) => {
  try {
    const { image, questions, choices = 5 } = req.body;

    if (!image) return res.status(400).json({ error: "No image provided" });
    if (!getProvider()) {
      return res.status(500).json({ error: "No AI API key configured. Set GROQ_API_KEY in .env file." });
    }

    const result = await scanOMR(image, questions, choices);
    res.json(result);
  } catch (err) {
    console.error("OMR scan error:", err?.message || err);

    if (err?.status === 401) return res.status(401).json({ error: "Invalid API key. Check your .env file." });
    if (err?.status === 429) return res.status(429).json({ error: "Rate limit exceeded. Wait a moment and try again." });

    res.status(500).json({ error: err?.message || "Internal server error" });
  }
});

// ===== Batch endpoint =====
app.post("/scan-omr-batch", async (req, res) => {
  try {
    const { images, questions, choices = 5 } = req.body;
    if (!Array.isArray(images) || !images.length) {
      return res.status(400).json({ error: "No images provided" });
    }

    const results = [];
    for (const img of images) {
      try {
        results.push(await scanOMR(img, questions, choices));
      } catch (err) {
        results.push({ answers: [], confidence: [], error: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    console.error("Batch scan error:", err);
    res.status(500).json({ error: err?.message || "Internal server error" });
  }
});

// ===== Theory Paper Scanning =====

// --- Step 1: Extract questions from question paper image ---

// Call AI with one or more images (vision)
// `images` can be a single string or an array of base64 strings
async function callAIWithImages(prompt, images) {
  const imageList = Array.isArray(images) ? images : [images];
  const provider = getProvider();
  if (!provider) throw new Error("No AI provider configured.");

  if (provider === "groq") {
    const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
    const content = [{ type: "text", text: prompt }];
    for (const img of imageList) {
      const url = img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`;
      content.push({ type: "image_url", image_url: { url } });
    }
    const res = await client.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content }],
      max_tokens: 4000, temperature: 0.1,
    });
    return res.choices[0]?.message?.content || "";
  }

  if (provider === "gemini") {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const parts = [prompt];
    for (const img of imageList) {
      const { mimeType, data } = extractBase64(img);
      parts.push({ inlineData: { mimeType, data } });
    }
    const res = await model.generateContent(parts);
    return res.response.text();
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const content = [{ type: "text", text: prompt }];
    for (const img of imageList) {
      const url = img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`;
      content.push({ type: "image_url", image_url: { url, detail: "high" } });
    }
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content }],
      max_tokens: 4000, temperature: 0.1,
    });
    return res.choices[0]?.message?.content || "";
  }
}

// Call AI with text only (for Word docs / extracted text)
async function callAIWithText(prompt) {
  const provider = getProvider();
  if (!provider) throw new Error("No AI provider configured.");

  if (provider === "groq") {
    const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
    const res = await client.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4000, temperature: 0.1,
    });
    return res.choices[0]?.message?.content || "";
  }

  if (provider === "gemini") {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const res = await model.generateContent(prompt);
    return res.response.text();
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4000, temperature: 0.1,
    });
    return res.choices[0]?.message?.content || "";
  }
}

// Extract text from a Word document (.docx) base64
async function extractTextFromDocx(base64Data) {
  const raw = base64Data.replace(/^data:[^;]+;base64,/, "");
  const buffer = Buffer.from(raw, "base64");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// Extract text from a PDF base64
async function extractTextFromPdf(base64Data) {
  const raw = base64Data.replace(/^data:[^;]+;base64,/, "");
  const buffer = Buffer.from(raw, "base64");
  const result = await pdfParse(buffer);
  return result.text;
}

function parseJSON(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in AI response");
  return JSON.parse(match[0]);
}

const QUESTION_EXTRACTION_PROMPT = `You are reading a question paper / exam paper. Extract ALL questions from it.

INSTRUCTIONS:
1. Read the entire content carefully
2. Extract every question — including sub-questions (a, b, c) as separate entries
3. Keep the original question text exactly as written
4. Include the question number as shown on the paper
5. If marks are mentioned next to a question, include them

Respond with ONLY valid JSON:
{
  "questions": [
    {
      "number": "<question number as shown, e.g. 1, 2a, 2b, 3>",
      "text": "<full question text exactly as written>",
      "marks": <marks if mentioned, otherwise null>
    }
  ],
  "subject": "<detected subject if visible, or null>",
  "totalQuestions": <count of questions extracted>,
  "notes": "<any relevant notes about the paper>"
}`;

// Extract questions — supports images, Word docs (.docx), and plain text
app.post("/extract-questions", async (req, res) => {
  try {
    const { image, fileData, fileType, text } = req.body;
    if (!image && !fileData && !text) {
      return res.status(400).json({ error: "No file or text provided" });
    }
    if (!getProvider()) return res.status(500).json({ error: "No AI API key configured." });

    let raw;

    // Case 1: Plain text or pasted questions
    if (text) {
      const prompt = QUESTION_EXTRACTION_PROMPT + `\n\nHere is the question paper text:\n\n${text}`;
      raw = await callAIWithText(prompt);
    }
    // Case 2: Word document (.docx)
    else if (fileData && (fileType === "docx" || fileType === "doc")) {
      console.log("Extracting text from Word document...");
      const docText = await extractTextFromDocx(fileData);
      console.log("Extracted text length:", docText.length);
      if (!docText.trim()) {
        return res.status(400).json({ error: "Could not extract text from the Word document. The file may be empty or corrupted." });
      }
      const prompt = QUESTION_EXTRACTION_PROMPT + `\n\nHere is the question paper text extracted from a Word document:\n\n${docText}`;
      raw = await callAIWithText(prompt);
    }
    // Case 3: PDF document
    else if (fileData && fileType === "pdf") {
      console.log("Extracting text from PDF...");
      const pdfText = await extractTextFromPdf(fileData);
      console.log("Extracted PDF text length:", pdfText.length);
      if (!pdfText.trim()) {
        return res.status(400).json({ error: "Could not extract text from the PDF. It may be image-based — try uploading as an image instead." });
      }
      const prompt = QUESTION_EXTRACTION_PROMPT + `\n\nHere is the question paper text extracted from a PDF:\n\n${pdfText}`;
      raw = await callAIWithText(prompt);
    }
    // Case 4: Image (photo/scan of question paper)
    else if (image) {
      const prompt = QUESTION_EXTRACTION_PROMPT.replace("from it", "from this image");
      raw = await callAIWithImages(prompt, image);
    }

    console.log("Question Extraction Raw:", raw);
    const parsed = parseJSON(raw);
    res.json(parsed);
  } catch (err) {
    console.error("Question extraction error:", err?.message || err);
    if (err?.status === 429) return res.status(429).json({ error: "Rate limit. Wait and try again." });
    res.status(500).json({ error: err?.message || "Internal server error" });
  }
});

// --- Step 2: Evaluate answer sheet against extracted questions ---

// `images` can be a single string or array of base64 strings
// `files` can be array of {fileData, fileType} for docs/PDFs
app.post("/evaluate-theory", async (req, res) => {
  try {
    const { images, files, questions } = req.body;

    if ((!images || !images.length) && (!files || !files.length)) {
      return res.status(400).json({ error: "No answer sheet provided" });
    }
    if (!questions || !Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: "No questions provided. Extract questions first." });
    }
    if (!getProvider()) return res.status(500).json({ error: "No AI API key configured." });

    const questionsText = questions.map((q, i) =>
      `Q${q.number || (i + 1)}. ${q.text}`
    ).join("\n");

    const numImages = (images || []).length;
    const numFiles = (files || []).length;

    const basePrompt = `You are an expert teacher checking a student's answer sheet against the questions from their exam.

QUESTION PAPER (these are the questions the student was asked):
${questionsText}

${numImages > 1 ? `IMPORTANT — MULTI-PAGE ANSWER SHEET:
The student's answer sheet is spread across ${numImages} pages/images. The images are in ORDER (page 1, page 2, etc.).
- An answer to one question may START on one page and CONTINUE on the next page
- Read ALL pages as one continuous answer sheet before evaluating
- Combine text from across pages for the same question
- Do NOT evaluate each page separately — evaluate the COMPLETE answer for each question across all pages
` : ""}
TASK: Read the student's answers and evaluate EACH answer's correctness as a percentage (0-100%).

FOR EACH ANSWER:
1. Read what the student actually wrote (transcribe it — if it spans multiple pages, combine it)
2. Compare it against what the correct/expected answer should be for that question
3. Give an accuracy percentage:
   - 0% = completely wrong, irrelevant, or not attempted
   - 10-30% = has some vague relation but mostly wrong
   - 40-60% = partially correct, some key points present but incomplete or has errors
   - 70-85% = mostly correct with minor errors or missing details
   - 90-100% = fully correct and complete
4. Explain briefly what was right and what was wrong/missing

IMPORTANT:
- Do NOT give marks or scores — only accuracy percentage
- Be honest and precise in your accuracy assessment
- If a question is not answered at all, mark it as 0% with "Not attempted"

Respond with ONLY valid JSON:
{
  "answers": [
    {
      "questionNumber": "<matching question number>",
      "questionText": "<the question>",
      "studentAnswer": "<COMPLETE answer — combine from all pages if it spans multiple pages>",
      "accuracyPercent": <0-100 integer>,
      "correctAnswer": "<what the ideal/correct answer should be, briefly>",
      "whatWasRight": "<what parts of the student's answer were correct>",
      "whatWasMissing": "<what was wrong or missing from the answer>"
    }
  ],
  "overallAccuracy": <average accuracy across all answers, 0-100>,
  "handwritingQuality": "<good/average/poor/N/A for typed>",
  "notes": "<any overall observations>"
}`;

    let raw;

    // Document-based answer sheets (Word/PDF) — extract and combine all text
    if (files && files.length > 0) {
      let combinedText = "";
      for (const f of files) {
        if (f.fileType === "docx" || f.fileType === "doc") {
          combinedText += await extractTextFromDocx(f.fileData) + "\n\n";
        } else if (f.fileType === "pdf") {
          combinedText += await extractTextFromPdf(f.fileData) + "\n\n";
        }
      }
      console.log("Combined answer sheet text length:", combinedText.length);
      if (!combinedText.trim()) {
        return res.status(400).json({ error: "Could not extract text from the uploaded files." });
      }
      const prompt = basePrompt + `\n\nHere is the student's answer sheet text:\n\n${combinedText}`;
      raw = await callAIWithText(prompt);
    }
    // Image-based answer sheets — send ALL images together
    else if (images && images.length > 0) {
      console.log(`Evaluating ${images.length} answer sheet image(s) together...`);
      const prompt = basePrompt.replace(
        "Read the student's answers",
        `Read the student's handwritten answers from ${images.length > 1 ? "these " + images.length + " pages (in order)" : "the image"}`
      );
      raw = await callAIWithImages(prompt, images);
    }

    console.log("Theory Evaluation Raw:", raw);
    const parsed = parseJSON(raw);
    res.json(parsed);
  } catch (err) {
    console.error("Theory evaluation error:", err?.message || err);
    if (err?.status === 401) return res.status(401).json({ error: "Invalid API key." });
    if (err?.status === 429) return res.status(429).json({ error: "Rate limit. Wait and try again." });
    res.status(500).json({ error: err?.message || "Internal server error" });
  }
});

// ===== Startup =====
const provider = getProvider();
app.listen(PORT, () => {
  console.log(`\n  OMR AI Server running on http://localhost:${PORT}`);
  console.log(`  AI Provider: ${provider ? provider.toUpperCase() + " ✓" : "NONE ✗ — set an API key in .env"}`);
  if (provider === "groq") console.log("  Model: Llama 4 Scout (FREE via Groq)");
  if (provider === "gemini") console.log("  Model: Gemini 2.0 Flash (FREE tier)");
  if (provider === "openai") console.log("  Model: GPT-4o (paid)");
  console.log(`  Endpoints:`);
  console.log(`    POST /scan-omr          — Scan single OMR sheet`);
  console.log(`    POST /scan-omr-batch    — Scan multiple OMR sheets`);
  console.log(`    POST /extract-questions  — Extract questions from question paper`);
  console.log(`    POST /evaluate-theory   — Evaluate answer sheet accuracy`);
  console.log(`    GET  /health            — Health check\n`);
});
