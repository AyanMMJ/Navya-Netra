// src/App.jsx — AI-Powered OMR Scanner
import React, { useEffect, useRef, useState } from "react";
import { scanOMRWithAI, gradeAnswers, videoFrameToBase64, imageToBase64, drawAIResultOverlay, checkAIBackend, extractQuestions, evaluateTheoryPaper, readFileAsBase64 } from "./utils/aiOmr";
import { detectOMRSheet } from "./utils/omrPreview";
import { detectOMRLayout } from "./utils/bubbleGrid";
import Modal from "./components/Modal";
import ScoreBar from "./components/ScoreBar";
import ResultsTable from "./components/ResultsTable";
import ResultsVisualization from "./components/ResultsVisualization";
import ImageCropper from "./components/ImageCropper";
import { autoCropSheet } from "./utils/omrCrop.js";
import * as XLSX from 'xlsx';

// Parse the answer key. Accepts letters (A,B,C,D,E — case-insensitive) or
// 0-based numbers, and tolerates "A-1" / "1-A" style tokens. A→0, B→1, ...
function parseAnswerKey(text) {
  return String(text || "")
    .split(",")
    .map((tok) => {
      const t = tok.trim().toUpperCase();
      if (!t) return -1;
      const letter = t.match(/[A-Z]/); // a letter wins — unambiguous
      if (letter) return letter[0].charCodeAt(0) - 65;
      const num = parseInt(t, 10);
      return Number.isNaN(num) ? -1 : num;
    });
}

// Fire this to open any image (data URL) in the full-screen preview.
function openImageZoom(url) {
  if (url) window.dispatchEvent(new CustomEvent("omr-zoom-image", { detail: url }));
}

// Full-screen image preview. Mounted once; opens on the "omr-zoom-image" event.
function ImageLightbox() {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const onZoom = (e) => setUrl(e.detail);
    const onKey = (e) => { if (e.key === "Escape") setUrl(null); };
    window.addEventListener("omr-zoom-image", onZoom);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("omr-zoom-image", onZoom);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!url) return null;
  return (
    <div
      onClick={() => setUrl(null)}
      className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center p-3 cursor-zoom-out"
    >
      <img
        src={url}
        alt="Result preview"
        onClick={(e) => e.stopPropagation()}
        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
      />
      <button
        onClick={() => setUrl(null)}
        aria-label="Close preview"
        className="absolute top-4 right-4 grid place-items-center w-11 h-11 rounded-full bg-white/20 hover:bg-white/35 text-white text-3xl leading-none"
      >
        ×
      </button>
      <div className="absolute bottom-4 inset-x-0 text-center text-white/70 text-xs">
        Tap anywhere to close · pinch to zoom
      </div>
    </div>
  );
}

// ===== Sheet templates (persisted in the browser) =====
const TEMPLATE_STORE = "omr-sheet-templates";

function loadTemplates() {
  try {
    const a = JSON.parse(localStorage.getItem(TEMPLATE_STORE) || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function persistTemplates(arr) {
  try {
    localStorage.setItem(TEMPLATE_STORE, JSON.stringify(arr));
  } catch {
    /* storage unavailable — keep templates in memory only */
  }
}

// Modal to create / delete sheet templates.
function TemplateManager({ open, onClose, templates, setTemplates }) {
  const [name, setName] = useState("");
  const [q, setQ] = useState("100");
  const [c, setC] = useState("4");
  const [cols, setCols] = useState("4");
  if (!open) return null;

  const add = () => {
    const Q = parseInt(q, 10);
    const C = parseInt(c, 10);
    const K = parseInt(cols, 10);
    if (!name.trim()) { alert("Enter a template name."); return; }
    if (!Q || Q < 1 || !C || C < 2 || C > 12 || !K || K < 1) {
      alert("Enter valid values — questions ≥ 1, choices 2-12, columns ≥ 1.");
      return;
    }
    setTemplates([
      ...templates,
      { id: `tpl-${Date.now()}`, name: name.trim(), questions: Q, choices: C, columns: K },
    ]);
    setName("");
  };
  const remove = (id) => setTemplates(templates.filter((t) => t.id !== id));

  return (
    <div
      className="fixed inset-0 z-[9998] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-md p-5 max-h-[88vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-semibold">Sheet Templates</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-2xl leading-none text-gray-500 hover:text-gray-800"
          >
            ×
          </button>
        </div>
        <p className="text-xs text-gray-600 mb-3">
          A template locks a known sheet format (questions, choices, columns) so
          scanning that format is reliable. Define it once, reuse it every time.
        </p>

        {templates.length > 0 ? (
          <div className="space-y-2 mb-4">
            {templates.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg border px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-gray-500">
                    {t.questions} questions · {t.choices} choices · {t.columns} columns
                  </div>
                </div>
                <button
                  onClick={() => remove(t.id)}
                  className="text-xs text-red-600 hover:underline"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-gray-500 mb-4">No templates yet — add one below.</div>
        )}

        <div className="rounded-xl border p-3 bg-gray-50">
          <div className="text-sm font-semibold mb-2">New template</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. XYZ College 50Q)"
            className="h-9 w-full rounded-lg border px-3 text-sm mb-2 outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <div className="grid grid-cols-3 gap-2">
            <label className="grid gap-1">
              <span className="text-xs font-medium text-gray-700">Questions</span>
              <input
                type="number" min="1" value={q}
                onChange={(e) => setQ(e.target.value)}
                className="h-9 rounded-lg border px-2 text-sm outline-none"
              />
              <span className="text-[10px] text-gray-500 leading-tight">Total on the sheet</span>
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-gray-700">Choices</span>
              <input
                type="number" min="2" max="12" value={c}
                onChange={(e) => setC(e.target.value)}
                className="h-9 rounded-lg border px-2 text-sm outline-none"
              />
              <span className="text-[10px] text-gray-500 leading-tight">Options/question (A,B,C,D = 4)</span>
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-gray-700">Columns</span>
              <input
                type="number" min="1" value={cols}
                onChange={(e) => setCols(e.target.value)}
                className="h-9 rounded-lg border px-2 text-sm outline-none"
              />
              <span className="text-[10px] text-gray-500 leading-tight">Side-by-side question blocks</span>
            </label>
          </div>
          <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2 text-[11px] text-amber-800 leading-snug">
            <b>Columns is NOT the number of choices.</b> "Choices" = options per
            question (A,B,C,D → 4). "Columns" = how many side-by-side blocks of
            questions the sheet is split into — a sheet with Q1-25 on the left and
            Q26-50 on the right has <b>2 columns</b>. A single list of questions = 1.
          </div>
          <button
            onClick={add}
            className="mt-3 w-full h-9 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
          >
            + Add Template
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false);

  // AI backend status
  const [aiStatus, setAiStatus] = useState({ available: false, reason: "Checking..." });

  // modals
  const [openCam, setOpenCam] = useState(false);
  const [openUpload, setOpenUpload] = useState(false);

  // shared grading state
  const [answerKeyText, setAnswerKeyText] = useState("1,2,0,2,4");
  const [score, setScore] = useState(0);
  const [picked, setPicked] = useState([]);

  // Marks configuration
  const [marksPerQuestion, setMarksPerQuestion] = useState("1");
  const [totalMarks, setTotalMarks] = useState("5");
  const [negativeMarks, setNegativeMarks] = useState("0");
  const [numberOfQuestions, setNumberOfQuestions] = useState("5");

  // sheet templates
  const [templates, setTemplates] = useState(loadTemplates);
  const [activeTemplateId, setActiveTemplateId] = useState("");
  const [templateModalOpen, setTemplateModalOpen] = useState(false);

  // camera elems + state
  const videoRef = useRef(null);
  const canvasCamRef = useRef(null);
  const [busyCam, setBusyCam] = useState(false);

  // robust camera start
  const [videoReady, setVideoReady] = useState(false);
  const [camError, setCamError] = useState("");
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const streamRef = useRef(null);

  // OpenCV + live preview (legacy auto-detect — kept but optional)
  const [cvReady, setCvReady] = useState(false);
  const [previewOn, setPreviewOn] = useState(false);
  const previewTimerRef = useRef(null);
  const previewBusyRef = useRef(false);
  const [sheetDetected, setSheetDetected] = useState(false);
  const [detectionInfo, setDetectionInfo] = useState("");
  const capturedFrameRef = useRef(null);

  // NEW: Manual capture flow for Camera OMR
  // captureStep: 'live' -> show video + capture button
  //              'preview' -> show captured photo + retake/scan buttons
  //              'results' -> show AI results + save/next
  const [captureStep, setCaptureStep] = useState('live');
  const [capturedPhoto, setCapturedPhoto] = useState(null); // base64 data URL
  const [autoCropping, setAutoCropping] = useState(false);

  // NEW: Cropper modal state — shared across features.
  // `cropperContext` tells us where to write the cropped result back.
  // Shape: { type: 'camera' } | { type: 'theory', index: number } | { type: 'qpaper', index: number }
  const [cropperOpen, setCropperOpen] = useState(false);
  const [cropperImage, setCropperImage] = useState(null);
  const [cropperContext, setCropperContext] = useState(null);

  // AI processing status for camera
  const [aiProcessing, setAiProcessing] = useState(false);
  const [aiNotes, setAiNotes] = useState("");

  // MULTI-UPLOAD results
  const [busyUp, setBusyUp] = useState(false);
  const [batchResults, setBatchResults] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });

  // Camera results state
  const [cameraResults, setCameraResults] = useState([]);
  const [studentName, setStudentName] = useState("");
  const [multiSessionMode, setMultiSessionMode] = useState(false);
  const [currentSessionResults, setCurrentSessionResults] = useState([]);

  // Visualization state
  const [showVisualization, setShowVisualization] = useState(false);

  // Theory paper scanning state
  const [openTheory, setOpenTheory] = useState(false);
  const [theoryStep, setTheoryStep] = useState(1); // 1 = upload questions, 2 = upload answers
  const [extractedQuestions, setExtractedQuestions] = useState([]); // [{number, text, marks}]
  const [questionPaperPreview, setQuestionPaperPreview] = useState(null);
  const [extractingQuestions, setExtractingQuestions] = useState(false);
  const [theoryProcessing, setTheoryProcessing] = useState(false);
  const [theoryResults, setTheoryResults] = useState([]);
  const [theoryUploadProgress, setTheoryUploadProgress] = useState({ current: 0, total: 0 });

  // NEW: Theory Camera capture flow
  // theoryInputMode: 'upload' | 'camera' — how the teacher provides answer sheets
  const [theoryInputMode, setTheoryInputMode] = useState('upload');
  const theoryVideoRef = useRef(null);
  const theoryStreamRef = useRef(null);
  const [theoryCamReady, setTheoryCamReady] = useState(false);
  const [theoryCamError, setTheoryCamError] = useState("");
  const [theoryCapturedPages, setTheoryCapturedPages] = useState([]); // base64 array (current student)
  const [theoryStudentName, setTheoryStudentName] = useState('');
  // Multi-session for theory
  const [theoryMultiSession, setTheoryMultiSession] = useState(false);
  const [theoryCurrentSession, setTheoryCurrentSession] = useState([]); // array of results
  // Question paper input mode: 'upload' | 'camera'
  const [qPaperInputMode, setQPaperInputMode] = useState('upload');
  const qPaperVideoRef = useRef(null);
  const qPaperStreamRef = useRef(null);
  const [qPaperCamReady, setQPaperCamReady] = useState(false);
  const [qPaperCapturedPages, setQPaperCapturedPages] = useState([]); // base64 array

  // NEW: Upload OMR multi-session mode
  const [uploadMultiSession, setUploadMultiSession] = useState(false);
  const [uploadStudentName, setUploadStudentName] = useState('');
  const [uploadCurrentSession, setUploadCurrentSession] = useState([]);

  // Calculate marks when marks configuration changes
  useEffect(() => {
    const calculatedTotal = parseInt(marksPerQuestion) * parseInt(numberOfQuestions);
    setTotalMarks(calculatedTotal.toString());
  }, [marksPerQuestion, numberOfQuestions]);

  // Check AI backend on mount
  useEffect(() => {
    checkAIBackend().then(setAiStatus);
    const iv = setInterval(async () => {
      const status = await checkAIBackend();
      setAiStatus(status);
    }, 10000);
    return () => clearInterval(iv);
  }, []);

  // OpenCV ready check
  useEffect(() => {
    const iv = setInterval(() => {
      if (window.cv && window.cv.getBuildInformation) {
        setCvReady(true);
        clearInterval(iv);
      }
    }, 200);
    return () => clearInterval(iv);
  }, []);

  // ===== camera helpers =====
  async function listVideoInputs() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "videoinput");
  }

  function chooseBackCamera(devs) {
    const byLabel = devs.find((d) => /back|rear|environment/i.test(d.label));
    return byLabel?.deviceId || devs[0]?.deviceId || null;
  }

  async function startCamera(deviceId = null) {
    setCamError("");
    setVideoReady(false);
    try {
      let devs = await listVideoInputs();
      if (!devs.length) {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tmp.getTracks().forEach((t) => t.stop());
        devs = await listVideoInputs();
      }
      setDevices(devs);
      const chosen = deviceId || chooseBackCamera(devs);
      setSelectedDeviceId(chosen);

      const constraints = chosen
        ? { video: { deviceId: { exact: chosen }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }
        : { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) return;
      video.setAttribute("playsinline", "");
      video.muted = true;
      video.autoplay = true;
      video.srcObject = stream;

      const onReady = () => setVideoReady(Boolean(video.videoWidth && video.videoHeight));
      video.addEventListener("loadedmetadata", onReady, { once: true });
      await video.play().catch(() => {});
      if (video.videoWidth && video.videoHeight) setVideoReady(true);
    } catch (err) {
      console.error(err);
      setCamError(err?.message || "Unable to access camera");
    }
  }

  function stopCamera() {
    setVideoReady(false);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const v = videoRef.current;
    if (v) v.srcObject = null;
  }

  // Reset camera state when modal opens/closes
  const resetCameraState = () => {
    setScore(0);
    setPicked([]);
    setBusyCam(false);
    setCamError("");
    setStudentName("");
    setMultiSessionMode(false);
    setCurrentSessionResults([]);
    setAiProcessing(false);
    setAiNotes("");
    setPreviewOn(false);
    setSheetDetected(false);
    setDetectionInfo("");
    capturedFrameRef.current = null;
    setCaptureStep('live');
    setCapturedPhoto(null);
  };

  // NEW: Reset only capture sub-state (keeps camera running)
  const resetCaptureOnly = () => {
    setCaptureStep('live');
    setCapturedPhoto(null);
    setScore(0);
    setPicked([]);
    setAiNotes("");
    setAiProcessing(false);
  };

  useEffect(() => {
    if (openCam) {
      resetCameraState();
      startCamera(selectedDeviceId);
    } else {
      stopCamera();
      stopPreview();
    }
    return () => { stopCamera(); stopPreview(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCam]);

  // Start/stop theory answer-sheet camera
  useEffect(() => {
    if (openTheory && theoryStep === 2 && theoryInputMode === 'camera') {
      startTheoryCamera();
    } else {
      stopTheoryCamera();
    }
    return () => stopTheoryCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTheory, theoryStep, theoryInputMode]);

  // Start/stop question-paper camera
  useEffect(() => {
    if (openTheory && theoryStep === 1 && qPaperInputMode === 'camera') {
      startQPaperCamera();
    } else {
      stopQPaperCamera();
    }
    return () => stopQPaperCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTheory, theoryStep, qPaperInputMode]);

  useEffect(() => {
    if (!openCam) return;
    const handler = async () => setDevices(await listVideoInputs());
    navigator.mediaDevices?.addEventListener?.("devicechange", handler);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", handler);
  }, [openCam]);

  // ===== LIVE PREVIEW with OpenCV contour detection =====
  const previewOnce = () => {
    if (!cvReady || !videoReady || previewBusyRef.current || !previewOn) return;
    previewBusyRef.current = true;
    try {
      const cv = window.cv;
      const video = videoRef.current;
      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;
      const tmp = document.createElement("canvas");
      tmp.width = vw; tmp.height = vh;
      tmp.getContext("2d").drawImage(video, 0, 0, vw, vh);
      const src = cv.imread(tmp);

      const { detected, bubbleCount, confidence, cleanImageBase64 } = detectOMRSheet(cv, src, canvasCamRef.current, {
        questions: parseInt(numberOfQuestions),
        choices: 5,
      });

      src.delete();

      if (detected) {
        // Auto-pause: sheet detected with good confidence
        setSheetDetected(true);
        setDetectionInfo(`${bubbleCount}/${numberOfQuestions} bubbles detected (${Math.round(confidence * 100)}% confidence)`);
        setPreviewOn(false);
        // Store the CLEAN warped sheet (no overlay) for AI scanning
        capturedFrameRef.current = cleanImageBase64;
      }
    } catch (e) {
      // ignore preview errors silently
    } finally {
      previewBusyRef.current = false;
    }
  };

  const startPreview = () => {
    if (!previewTimerRef.current) {
      previewTimerRef.current = setInterval(previewOnce, 200);
    }
  };

  const stopPreview = () => {
    if (previewTimerRef.current) {
      clearInterval(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  };

  // Auto-preview disabled by default — teacher explicitly clicks "Capture Photo"
  // Leaving the plumbing in case we want to re-enable in future.
  useEffect(() => {
    if (openCam && cvReady && videoReady && previewOn) startPreview();
    else stopPreview();
    return () => stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCam, cvReady, videoReady, previewOn]);

  const AK = parseAnswerKey(answerKeyText);

  // Active sheet template (null = auto-detect layout).
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) || null;

  // Persist templates whenever they change.
  useEffect(() => { persistTemplates(templates); }, [templates]);

  // When a template is selected, sync the question count to it.
  useEffect(() => {
    const t = templates.find((x) => x.id === activeTemplateId);
    if (t) setNumberOfQuestions(String(t.questions));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplateId]);

  // ===== Calculate Marks Function =====
  const calculateMarks = (pickedAnswers) => {
    const marksPerQ = parseFloat(marksPerQuestion);
    const negativePerQ = parseFloat(negativeMarks);
    const totalQs = parseInt(numberOfQuestions);

    let correctAnswers = 0;
    let wrongAnswers = 0;
    let unanswered = 0;

    for (let i = 0; i < Math.min(pickedAnswers.length, totalQs); i++) {
      if (pickedAnswers[i] === -1) {
        unanswered++;
      } else if (pickedAnswers[i] === AK[i]) {
        correctAnswers++;
      } else {
        wrongAnswers++;
      }
    }

    const marksObtained = (correctAnswers * marksPerQ) - (wrongAnswers * negativePerQ);
    const maximumMarks = totalQs * marksPerQ;

    return {
      correctAnswers,
      wrongAnswers,
      unanswered,
      marksObtained: Math.max(0, marksObtained),
      maximumMarks,
      percentage: maximumMarks > 0 ? ((Math.max(0, marksObtained) / maximumMarks) * 100).toFixed(1) : "0.0"
    };
  };

  // ===== Multi-Session Functions =====
  const startMultiSession = () => {
    setMultiSessionMode(true);
    setCurrentSessionResults([]);
    setStudentName("");
    setScore(0);
    setPicked([]);
  };

  const saveCurrentStudentResult = () => {
    if (!picked.length || !studentName.trim()) {
      alert("Please enter student name and scan the marksheet first");
      return;
    }

    const marksData = calculateMarks(picked);
    const newResult = {
      id: `camera-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: studentName.trim(),
      score: score,
      picked: [...picked],
      previewUrl: canvasCamRef.current?.toDataURL("image/png") || capturedPhoto || null,
      ...marksData,
      timestamp: new Date().toLocaleString(),
      studentNumber: currentSessionResults.length + 1
    };

    setCurrentSessionResults(prev => [...prev, newResult]);
    setCameraResults(prev => [newResult, ...prev]);

    // Reset for next student — go back to live capture
    setStudentName("");
    setScore(0);
    setPicked([]);
    setAiNotes("");
    setCapturedPhoto(null);
    setCaptureStep('live');
  };

  const finishMultiSession = () => {
    setMultiSessionMode(false);
    setStudentName("");
  };

  const downloadMultiSessionExcel = () => {
    if (currentSessionResults.length === 0) {
      alert("No session results to download");
      return;
    }

    const workbook = XLSX.utils.book_new();

    const excelData = currentSessionResults.map((result) => ({
      "Student Number": result.studentNumber,
      "Student Name": result.name,
      "Score (%)": result.percentage,
      "Marks Obtained": result.marksObtained.toFixed(2),
      "Maximum Marks": result.maximumMarks,
      "Correct Answers": result.correctAnswers,
      "Wrong Answers": result.wrongAnswers,
      "Unanswered": result.unanswered,
      "Total Questions": numberOfQuestions,
      "Marks Per Question": marksPerQuestion,
      "Negative Marks": negativeMarks,
      "Answers": `[${result.picked.join(", ")}]`,
      "Date Time": result.timestamp,
      "Status": parseFloat(result.percentage) >= 40 ? "Pass" : "Fail"
    }));

    const totalStudents = currentSessionResults.length;
    const averageMarks = currentSessionResults.reduce((sum, r) => sum + r.marksObtained, 0) / totalStudents;
    const averagePercentage = currentSessionResults.reduce((sum, r) => sum + parseFloat(r.percentage), 0) / totalStudents;
    const totalPass = currentSessionResults.filter(r => parseFloat(r.percentage) >= 40).length;

    excelData.push({});
    excelData.push({
      "Student Number": "SUMMARY",
      "Student Name": `Total Students: ${totalStudents}`,
      "Score (%)": averagePercentage.toFixed(1),
      "Marks Obtained": averageMarks.toFixed(2),
      "Maximum Marks": "N/A",
      "Correct Answers": "N/A",
      "Wrong Answers": "N/A",
      "Unanswered": "N/A",
      "Total Questions": "N/A",
      "Marks Per Question": "N/A",
      "Negative Marks": "N/A",
      "Answers": `Pass: ${totalPass}, Fail: ${totalStudents - totalPass}`,
      "Date Time": new Date().toLocaleString(),
      "Status": "Report"
    });

    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Multi-Session OMR Results");

    const fileName = `Multi_Session_OMR_Results_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(workbook, fileName);
  };

  // ===== Single Student Functions =====
  const saveSingleStudentResult = () => {
    if (!picked.length) {
      alert("Please scan the marksheet first");
      return;
    }

    const studentNameToUse = studentName.trim() || `Student_${Date.now()}`;
    const marksData = calculateMarks(picked);
    const newResult = {
      id: `camera-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: studentNameToUse,
      score: score,
      picked: [...picked],
      previewUrl: canvasCamRef.current?.toDataURL("image/png") || capturedPhoto || null,
      ...marksData,
      timestamp: new Date().toLocaleString()
    };

    setCameraResults(prev => [newResult, ...prev]);
    // Reset to live capture for next scan
    setStudentName("");
    setScore(0);
    setPicked([]);
    setAiNotes("");
    setCapturedPhoto(null);
    setCaptureStep('live');
  };

  const downloadCameraResultsExcel = () => {
    if (cameraResults.length === 0) {
      alert("No camera results to download");
      return;
    }

    const workbook = XLSX.utils.book_new();

    const excelData = cameraResults.map((result) => ({
      "Student Name": result.name,
      "Score (%)": result.percentage,
      "Marks Obtained": result.marksObtained.toFixed(2),
      "Maximum Marks": result.maximumMarks,
      "Correct Answers": result.correctAnswers,
      "Wrong Answers": result.wrongAnswers,
      "Unanswered": result.unanswered,
      "Total Questions": numberOfQuestions,
      "Marks Per Question": marksPerQuestion,
      "Negative Marks": negativeMarks,
      "Answers": `[${result.picked.join(", ")}]`,
      "Date Time": result.timestamp,
      "Status": parseFloat(result.percentage) >= 40 ? "Pass" : "Fail"
    }));

    const totalStudents = cameraResults.length;
    const averageMarks = cameraResults.reduce((sum, r) => sum + r.marksObtained, 0) / totalStudents;
    const averagePercentage = cameraResults.reduce((sum, r) => sum + parseFloat(r.percentage), 0) / totalStudents;
    const totalPass = cameraResults.filter(r => parseFloat(r.percentage) >= 40).length;

    excelData.push({});
    excelData.push({
      "Student Name": "SUMMARY",
      "Score (%)": averagePercentage.toFixed(1),
      "Marks Obtained": averageMarks.toFixed(2),
      "Maximum Marks": "N/A",
      "Correct Answers": "N/A",
      "Wrong Answers": "N/A",
      "Unanswered": "N/A",
      "Total Questions": `Total Students: ${totalStudents}`,
      "Marks Per Question": "N/A",
      "Negative Marks": "N/A",
      "Answers": `Pass: ${totalPass}, Fail: ${totalStudents - totalPass}`,
      "Date Time": new Date().toLocaleString(),
      "Status": "Report"
    });

    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Camera OMR Results");

    const fileName = `Camera_OMR_Results_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(workbook, fileName);
  };

  const clearCameraResults = () => {
    setCameraResults([]);
    setCurrentSessionResults([]);
  };

  // ===== NEW: Capture photo from live video =====
  const captureCameraPhoto = () => {
    const video = videoRef.current;
    if (!video || !videoReady) {
      alert("Camera not ready yet. Please wait.");
      return;
    }
    try {
      const base64 = videoFrameToBase64(video, 1800);
      setCapturedPhoto(base64);
      setCaptureStep('preview');
      // Reset any previous scan state
      setPicked([]);
      setScore(0);
      setAiNotes("");
    } catch (e) {
      console.error("Capture error:", e);
      alert("Could not capture photo: " + e.message);
    }
  };

  // NEW: Retake photo — go back to live video
  const retakePhoto = () => {
    setCapturedPhoto(null);
    setCaptureStep('live');
    setPicked([]);
    setScore(0);
    setAiNotes("");
  };

  // NEW: Auto-detect sheet and crop (Camera OMR)
  const autoCropCameraPhoto = async () => {
    if (!capturedPhoto) return;
    if (!window.cv || !window.cv.getBuildInformation) {
      alert("OpenCV is still loading. Please wait a few seconds and try again.");
      return;
    }
    setAutoCropping(true);
    try {
      const { cropped, corners } = await autoCropSheet(window.cv, capturedPhoto);
      if (!cropped) {
        alert("Could not auto-detect the OMR sheet boundary. Try 'Manual Crop' and adjust the corners yourself.");
        return;
      }
      setCapturedPhoto(cropped);
    } catch (e) {
      console.error(e);
      alert("Auto-crop failed: " + (e?.message || "Unknown error"));
    } finally {
      setAutoCropping(false);
    }
  };

  // NEW: Open manual crop UI for Camera OMR
  const openManualCropCamera = () => {
    if (!capturedPhoto) return;
    setCropperImage(capturedPhoto);
    setCropperContext({ type: 'camera' });
    setCropperOpen(true);
  };

  // NEW: Cropper applied handler — routes result to the right place
  const handleCropperApply = (croppedBase64) => {
    if (!cropperContext) {
      setCropperOpen(false);
      return;
    }
    if (cropperContext.type === 'camera') {
      setCapturedPhoto(croppedBase64);
    } else if (cropperContext.type === 'theory') {
      setTheoryCapturedPages(prev => {
        const next = [...prev];
        next[cropperContext.index] = croppedBase64;
        return next;
      });
    } else if (cropperContext.type === 'qpaper') {
      setQPaperCapturedPages(prev => {
        const next = [...prev];
        next[cropperContext.index] = croppedBase64;
        return next;
      });
    }
    setCropperOpen(false);
    setCropperImage(null);
    setCropperContext(null);
  };

  const handleCropperCancel = () => {
    setCropperOpen(false);
    setCropperImage(null);
    setCropperContext(null);
  };

  // Auto-crop a captured theory page (by index)
  const autoCropTheoryPage = async (idx) => {
    const img = theoryCapturedPages[idx];
    if (!img || !window.cv) return;
    try {
      const { cropped } = await autoCropSheet(window.cv, img);
      if (!cropped) {
        alert("Could not auto-detect boundary for this page. Use Manual Crop.");
        return;
      }
      setTheoryCapturedPages(prev => {
        const next = [...prev];
        next[idx] = cropped;
        return next;
      });
    } catch (e) {
      alert("Auto-crop failed: " + e.message);
    }
  };

  // Open manual crop for a theory page
  const openManualCropTheory = (idx) => {
    const img = theoryCapturedPages[idx];
    if (!img) return;
    setCropperImage(img);
    setCropperContext({ type: 'theory', index: idx });
    setCropperOpen(true);
  };

  // Auto-crop a captured question paper page
  const autoCropQPaperPage = async (idx) => {
    const img = qPaperCapturedPages[idx];
    if (!img || !window.cv) return;
    try {
      const { cropped } = await autoCropSheet(window.cv, img);
      if (!cropped) {
        alert("Could not auto-detect boundary for this page. Use Manual Crop.");
        return;
      }
      setQPaperCapturedPages(prev => {
        const next = [...prev];
        next[idx] = cropped;
        return next;
      });
    } catch (e) {
      alert("Auto-crop failed: " + e.message);
    }
  };

  // Open manual crop for a question paper page
  const openManualCropQPaper = (idx) => {
    const img = qPaperCapturedPages[idx];
    if (!img) return;
    setCropperImage(img);
    setCropperContext({ type: 'qpaper', index: idx });
    setCropperOpen(true);
  };

  // ===== AI-POWERED SCAN (Camera) =====
  // Uses the manually captured photo
  const captureAndGrade = async () => {
    if (busyCam || aiProcessing) return;

    if (!aiStatus.available || !aiStatus.aiConfigured) {
      alert("AI backend not ready. Make sure:\n1. Backend server is running (npm run server)\n2. API key is set in .env file");
      return;
    }

    // Need a captured photo first
    if (!capturedPhoto) {
      alert("Please click 'Capture Photo' first, verify the image looks clear, then press Scan.");
      return;
    }

    setAiProcessing(true);
    setBusyCam(true);
    setAiNotes("");

    try {
      const base64Image = capturedPhoto;

      // Load the captured photo so OpenCV can analyse it.
      const sheetImg = new Image();
      sheetImg.src = base64Image;
      await new Promise((r) => { sheetImg.onload = r; sheetImg.onerror = r; });

      // Auto-detect the sheet layout (rows, columns, choices) and read the
      // marks with OpenCV — handles single/multi-column sheets of any size.
      const layout = detectOMRLayout(window.cv, sheetImg, activeTemplate);

      let finalAnswers;
      let finalConfidence;
      let scanNote;

      if (layout && layout.questions.length) {
        finalAnswers = layout.questions.map((q) => q.marked);
        finalConfidence = layout.questions.map((q) => q.confidence);
        const m = layout.meta;
        scanNote = `Auto-detected ${finalAnswers.length} questions · ${m.choices} choices`
          + `${m.columns > 1 ? ` · ${m.columns} columns` : ""}.`;
        console.log("Layout detected:", m, finalAnswers);
      } else {
        // Detection failed — fall back to the AI scanner.
        const aiResult = await scanOMRWithAI(base64Image, parseInt(numberOfQuestions) || 5, 5);
        finalAnswers = aiResult.answers;
        finalConfidence = aiResult.confidence;
        scanNote = aiResult.notes || "Scanned with AI (layout auto-detect unavailable).";
        console.log("AI fallback result:", finalAnswers);
      }

      // Keep the question count in sync with what was detected.
      if (finalAnswers.length && String(finalAnswers.length) !== String(numberOfQuestions)) {
        setNumberOfQuestions(String(finalAnswers.length));
      }

      // Grade the detected answers
      const grading = gradeAnswers(finalAnswers, AK);

      // Update state
      setPicked(finalAnswers);
      setScore(grading.scorePct);
      setAiNotes(scanNote);

      if (canvasCamRef.current) {
        drawAIResultOverlay(canvasCamRef.current, {
          imageSource: sheetImg,
          picked: finalAnswers,
          answerKey: AK,
          confidence: finalConfidence,
          layout,
          questions: finalAnswers.length,
          choices: layout ? layout.meta.choices : 5,
        });
      }

      setCaptureStep('results');

    } catch (err) {
      console.error("AI Processing Error:", err);
      alert("AI Processing Error: " + err.message);
    } finally {
      setAiProcessing(false);
      setBusyCam(false);
    }
  };

  // ===== AI-POWERED MULTI-UPLOAD HANDLER =====
  async function onFiles(e) {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith("image/"));
    if (!files.length) return;

    if (!aiStatus.available || !aiStatus.aiConfigured) {
      alert("AI backend not ready. Make sure:\n1. Backend server is running (npm run server)\n2. GEMINI_API_KEY is set in .env file");
      return;
    }

    // In multi-session mode, require student name
    if (uploadMultiSession && !uploadStudentName.trim()) {
      alert("Please enter the student name before uploading in multi-session mode.");
      e.target.value = "";
      return;
    }

    setBusyUp(true);
    setUploadProgress({ current: 0, total: files.length });

    const newResults = [];

    // Process sequentially to avoid rate limits
    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      setUploadProgress({ current: idx + 1, total: files.length });

      try {
        const img = await loadImageFromFile(file);
        const base64Image = imageToBase64(img);

        // Auto-detect the layout and read the marks with OpenCV.
        const layout = detectOMRLayout(window.cv, img, activeTemplate);

        let finalAnswers;
        let finalConfidence;
        let scanNote;

        if (layout && layout.questions.length) {
          finalAnswers = layout.questions.map((q) => q.marked);
          finalConfidence = layout.questions.map((q) => q.confidence);
          const m = layout.meta;
          scanNote = `Auto-detected ${finalAnswers.length} questions · ${m.choices} choices`
            + `${m.columns > 1 ? ` · ${m.columns} columns` : ""}.`;
        } else {
          // Detection failed — fall back to the AI scanner.
          const aiResult = await scanOMRWithAI(base64Image, parseInt(numberOfQuestions) || 5, 5);
          finalAnswers = aiResult.answers;
          finalConfidence = aiResult.confidence;
          scanNote = aiResult.notes || "Scanned with AI (layout auto-detect unavailable).";
        }

        // Grade
        const grading = gradeAnswers(finalAnswers, AK);
        const marksData = calculateMarks(finalAnswers);

        // Draw overlay for preview
        const previewCanvas = document.createElement("canvas");
        drawAIResultOverlay(previewCanvas, {
          imageSource: img,
          picked: finalAnswers,
          answerKey: AK,
          confidence: finalConfidence,
          layout,
          questions: finalAnswers.length,
          choices: layout ? layout.meta.choices : 5,
        });
        const previewUrl = previewCanvas.toDataURL("image/png");

        const displayName = uploadMultiSession
          ? (files.length > 1 ? `${uploadStudentName.trim()} (${file.name})` : uploadStudentName.trim())
          : file.name;

        newResults.push({
          id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: displayName,
          studentName: uploadMultiSession ? uploadStudentName.trim() : null,
          score: grading.scorePct,
          picked: finalAnswers,
          previewUrl,
          ...marksData,
          aiNotes: scanNote,
          studentNumber: uploadMultiSession ? uploadCurrentSession.length + 1 : undefined,
        });

      } catch (err) {
        console.error("Upload process error:", err);
        newResults.push({
          id: `${file.name}-${Date.now()}-err`,
          name: file.name,
          score: 0,
          picked: [],
          previewUrl: null,
          error: err?.message || "Failed to process",
          correctAnswers: 0,
          wrongAnswers: 0,
          unanswered: parseInt(numberOfQuestions),
          marksObtained: 0,
          maximumMarks: parseFloat(totalMarks),
          percentage: "0.0"
        });
      }
    }

    setBatchResults(prev => [...newResults, ...prev]);
    if (uploadMultiSession) {
      setUploadCurrentSession(prev => [...newResults, ...prev]);
      setUploadStudentName('');
    }
    setBusyUp(false);
    setUploadProgress({ current: 0, total: 0 });
    e.target.value = "";
  }

  function clearUploads() {
    setBatchResults([]);
    setUploadCurrentSession([]);
  }

  // ===== Upload Multi-Session helpers =====
  const startUploadMultiSession = () => {
    setUploadMultiSession(true);
    setUploadCurrentSession([]);
    setUploadStudentName('');
  };

  const finishUploadMultiSession = () => {
    setUploadMultiSession(false);
    setUploadStudentName('');
  };

  const downloadUploadSessionExcel = () => {
    if (!uploadCurrentSession.length) {
      alert("No session results to download");
      return;
    }
    const workbook = XLSX.utils.book_new();
    const excelData = uploadCurrentSession.map((result) => ({
      "Student #": result.studentNumber || '',
      "Student Name": result.studentName || result.name,
      "Score (%)": result.percentage,
      "Marks Obtained": result.marksObtained?.toFixed(2) || '0',
      "Maximum Marks": result.maximumMarks || '0',
      "Correct Answers": result.correctAnswers || 0,
      "Wrong Answers": result.wrongAnswers || 0,
      "Unanswered": result.unanswered || 0,
      "Total Questions": numberOfQuestions,
      "Answers": `[${result.picked.join(", ")}]`,
      "Status": parseFloat(result.percentage) >= 40 ? "Pass" : "Fail"
    }));
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Upload Multi-Session");
    XLSX.writeFile(workbook, `Upload_Multi_Session_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  // ===== EXCEL DOWNLOAD FUNCTION =====
  const downloadExcelForUploads = () => {
    if (batchResults.length === 0) {
      alert("No results to download");
      return;
    }

    const workbook = XLSX.utils.book_new();

    const excelData = batchResults.map((result) => {
      const fileName = result.name.replace(/\.[^/.]+$/, "");
      const date = new Date().toLocaleString();

      return {
        "Student Name": fileName,
        "Score (%)": result.percentage,
        "Marks Obtained": result.marksObtained.toFixed(2),
        "Maximum Marks": result.maximumMarks,
        "Correct Answers": result.correctAnswers,
        "Wrong Answers": result.wrongAnswers,
        "Unanswered": result.unanswered,
        "Total Questions": numberOfQuestions,
        "Marks Per Question": marksPerQuestion,
        "Negative Marks": negativeMarks,
        "Answers": `[${result.picked.join(", ")}]`,
        "Date Time": date,
        "File Name": result.name,
        "Status": parseFloat(result.percentage) >= 40 ? "Pass" : "Fail"
      };
    });

    const totalStudents = batchResults.length;
    const averageMarks = batchResults.reduce((sum, r) => sum + r.marksObtained, 0) / totalStudents;
    const averagePercentage = batchResults.reduce((sum, r) => sum + parseFloat(r.percentage), 0) / totalStudents;
    const totalPass = batchResults.filter(r => parseFloat(r.percentage) >= 40).length;

    excelData.push({});
    excelData.push({
      "Student Name": "SUMMARY",
      "Score (%)": averagePercentage.toFixed(1),
      "Marks Obtained": averageMarks.toFixed(2),
      "Maximum Marks": "N/A",
      "Correct Answers": "N/A",
      "Wrong Answers": "N/A",
      "Unanswered": "N/A",
      "Total Questions": `Total Students: ${totalStudents}`,
      "Marks Per Question": "N/A",
      "Negative Marks": "N/A",
      "Answers": `Pass: ${totalPass}, Fail: ${totalStudents - totalPass}`,
      "Date Time": new Date().toLocaleString(),
      "File Name": "N/A",
      "Status": "Report"
    });

    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "OMR Results");

    const fileName = `OMR_Results_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(workbook, fileName);
  };

  // ===== THEORY PAPER FUNCTIONS =====

  // Step 1: Upload question paper → AI extracts questions
  // Supports: images (jpg/png), Word docs (.docx/.doc)
  async function onQuestionPaperUpload(e) {
    const file = (e.target.files || [])[0];
    if (!file) return;

    if (!aiStatus.available || !aiStatus.aiConfigured) {
      alert("AI backend not ready.");
      return;
    }

    setExtractingQuestions(true);
    try {
      const fileName = file.name.toLowerCase();
      const isWord = fileName.endsWith(".docx") || fileName.endsWith(".doc");
      const isPdf = fileName.endsWith(".pdf");
      const isImage = file.type.startsWith("image/");

      let payload = {};

      if (isWord) {
        const base64 = await readFileAsBase64(file);
        setQuestionPaperPreview(null);
        payload = { fileData: base64, fileType: fileName.endsWith(".docx") ? "docx" : "doc" };
      } else if (isPdf) {
        const base64 = await readFileAsBase64(file);
        setQuestionPaperPreview(null);
        payload = { fileData: base64, fileType: "pdf" };
      } else if (isImage) {
        const img = await loadImageFromFile(file);
        const base64 = imageToBase64(img);
        setQuestionPaperPreview(base64);
        payload = { image: base64 };
      } else {
        const text = await file.text();
        if (text.trim()) {
          setQuestionPaperPreview(null);
          payload = { text };
        } else {
          alert("Unsupported file type. Upload an image, Word doc (.docx), PDF, or text file.");
          setExtractingQuestions(false);
          return;
        }
      }

      const result = await extractQuestions(payload);
      console.log("Extracted questions:", result);

      if (result.questions && result.questions.length > 0) {
        setExtractedQuestions(result.questions);
        setTheoryStep(2);
      } else {
        alert("Could not extract any questions. Try a different file or clearer image.");
      }
    } catch (err) {
      console.error("Question extraction error:", err);
      alert("Error extracting questions: " + err.message);
    } finally {
      setExtractingQuestions(false);
      e.target.value = "";
    }
  }

  // Step 2: Upload answer sheets → ALL files sent together as one answer sheet
  // The AI sees all pages/images as one continuous document
  async function onAnswerSheetUpload(e) {
    const fileList = Array.from(e.target.files || []);
    if (!fileList.length) return;

    if (!extractedQuestions.length) {
      alert("Upload the question paper first.");
      return;
    }

    setTheoryProcessing(true);
    setTheoryUploadProgress({ current: 0, total: fileList.length });

    try {
      // Separate files into images and documents, process ALL together
      const allImages = [];
      const allFiles = [];
      const previewUrls = [];
      const fileNames = [];

      for (let idx = 0; idx < fileList.length; idx++) {
        const file = fileList[idx];
        setTheoryUploadProgress({ current: idx + 1, total: fileList.length });
        fileNames.push(file.name);

        const fileName = file.name.toLowerCase();
        const isWord = fileName.endsWith(".docx") || fileName.endsWith(".doc");
        const isPdf = fileName.endsWith(".pdf");
        const isImage = file.type.startsWith("image/");

        if (isWord) {
          const base64 = await readFileAsBase64(file);
          allFiles.push({ fileData: base64, fileType: fileName.endsWith(".docx") ? "docx" : "doc" });
        } else if (isPdf) {
          const base64 = await readFileAsBase64(file);
          allFiles.push({ fileData: base64, fileType: "pdf" });
        } else if (isImage) {
          const img = await loadImageFromFile(file);
          const base64 = imageToBase64(img);
          allImages.push(base64);
          previewUrls.push(base64);
        } else {
          // skip unsupported
          console.warn("Skipping unsupported file:", file.name);
        }
      }

      if (!allImages.length && !allFiles.length) {
        alert("No supported files found. Upload images, Word docs, or PDFs.");
        setTheoryProcessing(false);
        return;
      }

      // Send ALL together as one student's complete answer sheet
      const payload = {};
      if (allImages.length) payload.images = allImages;
      if (allFiles.length) payload.files = allFiles;

      const result = await evaluateTheoryPaper(payload, extractedQuestions);

      const combinedName = fileNames.length === 1
        ? fileNames[0]
        : `${fileNames.length} pages (${fileNames.join(", ")})`;

      setTheoryResults(prev => [{
        id: `theory-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: combinedName,
        previewUrl: previewUrls[0] || null,
        allPreviewUrls: previewUrls,
        ...result,
        timestamp: new Date().toLocaleString(),
      }, ...prev]);

    } catch (err) {
      console.error("Theory evaluation error:", err);
      setTheoryResults(prev => [{
        id: `theory-${Date.now()}-err`,
        name: fileList.map(f => f.name).join(", "),
        previewUrl: null,
        error: err?.message || "Failed to process",
        answers: [],
        overallAccuracy: 0,
        timestamp: new Date().toLocaleString(),
      }, ...prev]);
    }

    setTheoryProcessing(false);
    setTheoryUploadProgress({ current: 0, total: 0 });
    e.target.value = "";
  }

  const resetTheory = () => {
    setTheoryStep(1);
    setExtractedQuestions([]);
    setQuestionPaperPreview(null);
    setTheoryResults([]);
    setTheoryCapturedPages([]);
    setTheoryStudentName('');
    setTheoryMultiSession(false);
    setTheoryCurrentSession([]);
    setQPaperCapturedPages([]);
    setTheoryInputMode('upload');
    setQPaperInputMode('upload');
    stopTheoryCamera();
    stopQPaperCamera();
  };

  // ===== Theory Camera: start/stop =====
  async function startTheoryCamera() {
    setTheoryCamError("");
    setTheoryCamReady(false);
    try {
      const constraints = {
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      };
      if (theoryStreamRef.current) {
        theoryStreamRef.current.getTracks().forEach(t => t.stop());
        theoryStreamRef.current = null;
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      theoryStreamRef.current = stream;
      const v = theoryVideoRef.current;
      if (!v) return;
      v.setAttribute("playsinline", "");
      v.muted = true;
      v.autoplay = true;
      v.srcObject = stream;
      const onReady = () => setTheoryCamReady(Boolean(v.videoWidth && v.videoHeight));
      v.addEventListener("loadedmetadata", onReady, { once: true });
      await v.play().catch(() => {});
      if (v.videoWidth && v.videoHeight) setTheoryCamReady(true);
    } catch (err) {
      console.error(err);
      setTheoryCamError(err?.message || "Unable to access camera");
    }
  }

  function stopTheoryCamera() {
    setTheoryCamReady(false);
    if (theoryStreamRef.current) {
      theoryStreamRef.current.getTracks().forEach(t => t.stop());
      theoryStreamRef.current = null;
    }
    const v = theoryVideoRef.current;
    if (v) v.srcObject = null;
  }

  // Capture one page from theory camera
  const captureTheoryPage = () => {
    const v = theoryVideoRef.current;
    if (!v || !theoryCamReady) {
      alert("Camera not ready");
      return;
    }
    try {
      const base64 = videoFrameToBase64(v, 1800);
      setTheoryCapturedPages(prev => [...prev, base64]);
    } catch (e) {
      alert("Could not capture: " + e.message);
    }
  };

  const removeTheoryCapturedPage = (idx) => {
    setTheoryCapturedPages(prev => prev.filter((_, i) => i !== idx));
  };

  // Scan captured theory pages with AI
  const scanCapturedTheoryPages = async () => {
    if (!theoryCapturedPages.length) {
      alert("Capture at least one page before scanning.");
      return;
    }
    if (!extractedQuestions.length) {
      alert("Upload the question paper first.");
      return;
    }
    if (!aiStatus.available || !aiStatus.aiConfigured) {
      alert("AI backend not ready.");
      return;
    }
    if (theoryMultiSession && !theoryStudentName.trim()) {
      alert("Enter the student's name before scanning.");
      return;
    }

    setTheoryProcessing(true);
    setTheoryUploadProgress({ current: 1, total: 1 });

    try {
      const result = await evaluateTheoryPaper(
        { images: theoryCapturedPages },
        extractedQuestions
      );

      const studentLabel = theoryStudentName.trim() ||
        (theoryMultiSession ? `Student ${theoryCurrentSession.length + 1}` : `Student_${Date.now()}`);

      const newResult = {
        id: `theory-cam-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: studentLabel,
        previewUrl: theoryCapturedPages[0] || null,
        allPreviewUrls: [...theoryCapturedPages],
        ...result,
        timestamp: new Date().toLocaleString(),
        studentNumber: theoryMultiSession ? theoryCurrentSession.length + 1 : undefined,
      };

      setTheoryResults(prev => [newResult, ...prev]);
      if (theoryMultiSession) {
        setTheoryCurrentSession(prev => [...prev, newResult]);
      }

      // Reset for next student
      setTheoryCapturedPages([]);
      setTheoryStudentName('');
    } catch (err) {
      console.error("Theory camera evaluation error:", err);
      alert("AI evaluation failed: " + (err?.message || "Unknown error"));
    } finally {
      setTheoryProcessing(false);
      setTheoryUploadProgress({ current: 0, total: 0 });
    }
  };

  // ===== Question Paper Camera =====
  async function startQPaperCamera() {
    setQPaperCamReady(false);
    try {
      const constraints = {
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      };
      if (qPaperStreamRef.current) {
        qPaperStreamRef.current.getTracks().forEach(t => t.stop());
        qPaperStreamRef.current = null;
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      qPaperStreamRef.current = stream;
      const v = qPaperVideoRef.current;
      if (!v) return;
      v.setAttribute("playsinline", "");
      v.muted = true;
      v.autoplay = true;
      v.srcObject = stream;
      v.addEventListener("loadedmetadata", () => setQPaperCamReady(Boolean(v.videoWidth && v.videoHeight)), { once: true });
      await v.play().catch(() => {});
      if (v.videoWidth && v.videoHeight) setQPaperCamReady(true);
    } catch (err) {
      alert("Camera error: " + (err?.message || err));
    }
  }

  function stopQPaperCamera() {
    setQPaperCamReady(false);
    if (qPaperStreamRef.current) {
      qPaperStreamRef.current.getTracks().forEach(t => t.stop());
      qPaperStreamRef.current = null;
    }
    const v = qPaperVideoRef.current;
    if (v) v.srcObject = null;
  }

  const captureQPaperPage = () => {
    const v = qPaperVideoRef.current;
    if (!v || !qPaperCamReady) {
      alert("Camera not ready");
      return;
    }
    try {
      const base64 = videoFrameToBase64(v, 1800);
      setQPaperCapturedPages(prev => [...prev, base64]);
    } catch (e) {
      alert("Could not capture: " + e.message);
    }
  };

  const removeQPaperCapturedPage = (idx) => {
    setQPaperCapturedPages(prev => prev.filter((_, i) => i !== idx));
  };

  // Extract questions from captured question-paper photos
  const extractQPaperFromCamera = async () => {
    if (!qPaperCapturedPages.length) {
      alert("Capture at least one page of the question paper first.");
      return;
    }
    if (!aiStatus.available || !aiStatus.aiConfigured) {
      alert("AI backend not ready.");
      return;
    }
    setExtractingQuestions(true);
    try {
      // Only single-image supported by /extract-questions currently; use the first page
      // For multi-page question papers, we'd need backend support — for now, batch extract and merge
      let allQuestions = [];
      for (const img of qPaperCapturedPages) {
        const result = await extractQuestions({ image: img });
        if (result?.questions?.length) allQuestions = allQuestions.concat(result.questions);
      }
      if (!allQuestions.length) {
        alert("Could not extract any questions. Try clearer photos with good lighting.");
        return;
      }
      setExtractedQuestions(allQuestions);
      setQuestionPaperPreview(qPaperCapturedPages[0]);
      setTheoryStep(2);
      stopQPaperCamera();
    } catch (err) {
      console.error(err);
      alert("Failed to extract questions: " + (err?.message || "Unknown error"));
    } finally {
      setExtractingQuestions(false);
    }
  };

  // Multi-session theory helpers
  const startTheoryMultiSession = () => {
    setTheoryMultiSession(true);
    setTheoryCurrentSession([]);
    setTheoryStudentName('');
    setTheoryCapturedPages([]);
  };

  const finishTheoryMultiSession = () => {
    setTheoryMultiSession(false);
    setTheoryStudentName('');
  };

  const downloadTheoryMultiSessionExcel = () => {
    const results = theoryCurrentSession;
    if (!results.length) {
      alert("No session results to download");
      return;
    }
    const workbook = XLSX.utils.book_new();
    const excelData = results.map((r) => {
      const row = {
        "Student #": r.studentNumber,
        "Student Name": r.name,
        "Overall Accuracy": (r.overallAccuracy ?? 0) + "%",
        "Handwriting": r.handwritingQuality || "",
        "Notes": r.notes || "",
      };
      (r.answers || []).forEach((ans, i) => {
        row[`Q${ans.questionNumber || (i + 1)} Accuracy`] = ans.accuracyPercent + "%";
        row[`Q${ans.questionNumber || (i + 1)} Student Answer`] = ans.studentAnswer || "";
      });
      row["Date Time"] = r.timestamp;
      return row;
    });
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Theory Multi-Session");
    XLSX.writeFile(workbook, `Theory_Multi_Session_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const downloadTheoryExcel = () => {
    if (!theoryResults.length) return;
    const workbook = XLSX.utils.book_new();

    const excelData = theoryResults.map((r) => {
      const fileName = r.name.replace(/\.[^/.]+$/, "");
      const row = {
        "Student Name": fileName,
        "Overall Accuracy": (r.overallAccuracy ?? 0) + "%",
        "Handwriting": r.handwritingQuality || "",
        "Notes": r.notes || "",
      };

      (r.answers || []).forEach((ans, i) => {
        row[`Q${ans.questionNumber || (i + 1)} Accuracy`] = ans.accuracyPercent + "%";
        row[`Q${ans.questionNumber || (i + 1)} Student Answer`] = ans.studentAnswer || "";
        row[`Q${ans.questionNumber || (i + 1)} What Was Right`] = ans.whatWasRight || "";
        row[`Q${ans.questionNumber || (i + 1)} What Was Missing`] = ans.whatWasMissing || "";
      });

      row["Date Time"] = r.timestamp;
      row["File Name"] = r.name;
      return row;
    });

    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Theory Accuracy");
    XLSX.writeFile(workbook, `Theory_Accuracy_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  function go(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setMenuOpen(false);
  }

  // Calculate current marks for display
  const currentMarks = calculateMarks(picked);

  return (
    <>
      {/* Full-screen image preview (opens on image/canvas click) */}
      <ImageLightbox />

      {/* Sheet template manager */}
      <TemplateManager
        open={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        templates={templates}
        setTemplates={setTemplates}
      />

      {/* NAVBAR */}
      <header className="fixed inset-x-0 top-0 z-40 glass-effect border-b">
        <div className="mx-auto w-full max-w-7xl px-4 md:px-6">
          <div className="flex h-16 md:h-20 items-center justify-between">
            <button onClick={() => go("home")} className="text-xl md:text-2xl font-extrabold gradient-text">
              Navya-Netra OMR
            </button>

            <nav className="hidden md:flex items-center gap-6">
              {["about", "services", "contact"].map((id) => (
                <button key={id} onClick={() => go(id)} className="text-gray-800 hover:text-indigo-600 font-medium">
                  {id[0].toUpperCase() + id.slice(1)}
                </button>
              ))}
              <button onClick={() => go("services")} className="btn-primary">
                Scan Now
              </button>
            </nav>

            <button className="md:hidden btn-secondary" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
              ☰
            </button>
          </div>

          {menuOpen && (
            <div className="md:hidden pb-4">
              <div className="flex flex-col gap-2">
                {["about", "services", "contact"].map((id) => (
                  <button key={id} onClick={() => go(id)} className="text-left px-3 py-2 rounded-xl hover:bg-indigo-50">
                    {id[0].toUpperCase() + id.slice(1)}
                  </button>
                ))}
                <button onClick={() => go("services")} className="btn-primary justify-center">
                  Scan Now
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* AI STATUS BANNER */}
      {!aiStatus.available && (
        <div className="fixed top-16 md:top-20 inset-x-0 z-30 bg-amber-50 border-b border-amber-200 px-4 py-2">
          <div className="mx-auto max-w-7xl flex items-center gap-2 text-sm text-amber-800">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            <span>AI Backend not connected. Run <code className="px-1 py-0.5 bg-amber-100 rounded text-xs">npm run server</code> in a separate terminal.</span>
          </div>
        </div>
      )}

      {/* HERO */}
      <section id="home" className={`pt-24 md:pt-32 ${!aiStatus.available ? "mt-8" : ""}`}>
        <div className="mx-auto w-full max-w-7xl px-4 md:px-6">
          <div className="grid gap-6 md:grid-cols-2 items-center">
            <div className="glass-effect rounded-3xl p-6 md:p-10 border">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/70 border">
                <span className={`w-2 h-2 rounded-full ${aiStatus.available && aiStatus.aiConfigured ? "bg-green-500" : "bg-amber-500"} animate-pulse`} />
                <span className="text-sm text-gray-700">
                  {aiStatus.available && aiStatus.aiConfigured
                    ? "AI Vision Powered • Accurate • Fast"
                    : aiStatus.reason}
                </span>
              </div>
              <h1 className="mt-4 text-3xl sm:text-4xl md:text-6xl font-black leading-tight">
                AI-Powered OMR — <span className="gradient-text">Accurate</span>
              </h1>
              <p className="mt-3 text-base sm:text-lg md:text-xl text-gray-700">
                AI Vision reads your OMR sheets with human-level accuracy. Point your camera or upload — instant results.
              </p>
              <div className="mt-5 flex flex-col sm:flex-row gap-3 flex-wrap">
                <button className="btn-primary text-sm sm:text-base px-4 sm:px-6 py-2.5 sm:py-3" onClick={() => setOpenCam(true)}>
                  Open Live Camera
                </button>
                <button className="btn-secondary text-sm sm:text-base px-4 sm:px-6 py-2.5 sm:py-3" onClick={() => setOpenUpload(true)}>
                  Upload Marksheet(s)
                </button>
                <button className="btn-secondary text-sm sm:text-base px-4 sm:px-6 py-2.5 sm:py-3" onClick={() => setOpenTheory(true)}>
                  Theory Papers
                </button>
              </div>
            </div>

            <div className="rounded-3xl border glass-effect p-5">
              <div className="aspect-[4/3] rounded-2xl border bg-white/60 grid place-items-center text-gray-600">
                <div className="text-center p-6">
                  <div className="text-4xl mb-3">🤖</div>
                  <h3 className="text-lg font-semibold mb-2">AI Vision OMR Scanner</h3>
                  <p className="text-sm text-gray-500">
                    Uses Gemini AI Vision to read OMR sheets with high accuracy — just like showing your sheet to ChatGPT.
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <span className="px-2 py-1 bg-green-50 text-green-700 text-xs rounded-md">Camera Scan</span>
                    <span className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded-md">Batch Upload</span>
                    <span className="px-2 py-1 bg-purple-50 text-purple-700 text-xs rounded-md">AI Grading</span>
                    <span className="px-2 py-1 bg-amber-50 text-amber-700 text-xs rounded-md">Excel Export</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ABOUT */}
      <section id="about" className="py-16 md:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 md:px-6">
          <h2 className="text-3xl md:text-4xl font-bold">About Us</h2>
          <p className="mt-3 text-gray-700 max-w-3xl">
            Navya-Netra OMR uses cutting-edge AI Vision (GPT-4o) to read and grade OMR answer sheets with near-perfect accuracy. Unlike traditional computer vision methods, our AI understands the visual layout of any OMR sheet and detects marked bubbles just like a human would — no rigid templates needed.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { t: "AI-Powered Accuracy", d: "Gemini AI Vision reads OMR sheets like a human — no more false detections or missed answers." },
              { t: "Camera & Upload", d: "Point your phone camera at the sheet or upload scanned images — both work with the same AI precision." },
              { t: "Instant Results", d: "Get detailed results with correct/wrong breakdown, marks calculation, and Excel export in seconds." },
            ].map((c, i) => (
              <div key={i} className="card-hover glass-effect rounded-2xl p-6 border">
                <h3 className="text-xl font-semibold">{c.t}</h3>
                <p className="mt-2 text-gray-700">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SERVICES */}
      <section id="services" className="py-16 md:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 md:px-6">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-3xl md:text-4xl font-bold">Services</h2>
              <p className="mt-2 text-gray-700">Choose how you want to scan and grade your marksheets.</p>
            </div>
          </div>

          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <ServiceCard
              title="Live Camera OMR"
              desc="Open camera → click photo → verify → AI scans. Supports any sheet size (10, 50, 100+ questions) and multi-session for whole classes."
              cta="Start Camera"
              onClick={() => setOpenCam(true)}
            />
            <ServiceCard
              title="Upload Marksheet(s)"
              desc="Upload scanned OMR sheets one by one or in bulk. Multi-session mode groups results by student name."
              cta="Upload & Grade"
              onClick={() => setOpenUpload(true)}
            />
            <ServiceCard
              title="Theory Paper Scanning"
              desc="Capture handwritten answer sheets via camera OR upload files. AI grades each answer with accuracy %. Multi-session for whole classes."
              cta="Evaluate Papers"
              onClick={() => setOpenTheory(true)}
            />
            <ServiceCard
              title="Configurable Answer Key"
              desc="Set your answer key, marks per question, and negative marking. Works for any number of questions."
              cta="Set Key Below"
              onClick={() => document.getElementById("contact")?.scrollIntoView({ behavior: "smooth" })}
            />
          </div>
        </div>
      </section>

      {/* CONTACT */}
      <section id="contact" className="py-16 md:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 md:px-6">
          <h2 className="text-3xl md:text-4xl font-bold">Contact Us</h2>
          <p className="mt-2 text-gray-700">Contact us to discuss your requirements.</p>

          <div className="mt-8 grid gap-8 md:grid-cols-2">
            <form
              className="bg-white rounded-2xl p-6 md:p-8 border"
              onSubmit={(e) => {
                e.preventDefault();
                const name = new FormData(e.currentTarget).get("name");
                alert(`Thanks, ${name}! We'll get back to you.`);
                e.currentTarget.reset();
              }}
            >
              <div className="grid gap-4">
                <label className="grid gap-1">
                  <span className="text-sm font-medium">Your Name</span>
                  <input name="name" required className="h-11 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500" />
                </label>
                <label className="grid gap-1">
                  <span className="text-sm font-medium">Email</span>
                  <input type="email" name="email" required className="h-11 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500" />
                </label>
                <label className="grid gap-1">
                  <span className="text-sm font-medium">Message</span>
                  <textarea name="message" required rows={5} className="rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500" />
                </label>
                <button className="btn-primary h-11">Send</button>
              </div>
            </form>

            <div className="glass-effect rounded-2xl p-4 sm:p-6 md:p-8 border">
              <h3 className="text-lg sm:text-xl font-semibold">Exam Configuration</h3>

              <div className="mt-4">
                <span className="text-sm font-medium">Sheet Template</span>
                <div className="flex gap-2 mt-1">
                  <select
                    value={activeTemplateId}
                    onChange={(e) => setActiveTemplateId(e.target.value)}
                    className="h-10 flex-1 min-w-0 rounded-lg border px-3 bg-white outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Auto-detect layout (default)</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.questions}Q · {t.choices}-choice · {t.columns}-col)
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setTemplateModalOpen(true)}
                    className="h-10 px-3 rounded-lg border text-sm font-medium hover:bg-gray-50 whitespace-nowrap"
                  >
                    Manage
                  </button>
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  {activeTemplate
                    ? `Locked to "${activeTemplate.name}" — ${activeTemplate.questions} questions, ${activeTemplate.choices} choices, ${activeTemplate.columns} columns.`
                    : "Auto-detect works for most sheets. For a known format, save a template for guaranteed-accurate scanning."}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:gap-4 mt-4">
                <label className="grid gap-1">
                  <span className="text-sm font-medium">No. of Questions</span>
                  <input
                    type="number"
                    min="1"
                    max="500"
                    value={numberOfQuestions}
                    onChange={(e) => setNumberOfQuestions(e.target.value)}
                    className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </label>

                <label className="grid gap-1">
                  <span className="text-sm font-medium">Marks per Question</span>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={marksPerQuestion}
                    onChange={(e) => setMarksPerQuestion(e.target.value)}
                    className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-4 mt-3">
                <label className="grid gap-1">
                  <span className="text-sm font-medium">Negative Marks</span>
                  <input
                    type="number"
                    step="0.25"
                    min="0"
                    value={negativeMarks}
                    onChange={(e) => setNegativeMarks(e.target.value)}
                    className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </label>

                <label className="grid gap-1">
                  <span className="text-sm font-medium">Total Marks</span>
                  <input
                    type="number"
                    value={totalMarks}
                    readOnly
                    className="h-10 rounded-lg border px-3 bg-gray-50 outline-none"
                  />
                </label>
              </div>

              <label className="grid gap-1 mt-4">
                <span className="text-sm font-medium">Answer Key ({numberOfQuestions} questions)</span>
                <input
                  className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                  value={answerKeyText}
                  onChange={(e) => setAnswerKeyText(e.target.value)}
                  placeholder={`e.g. ${Array.from({length: parseInt(numberOfQuestions)}, (_, i) => i % 5).join(",")}`}
                />
              </label>
              <p className="mt-2 text-xs text-gray-600">Comma-separated answers for {numberOfQuestions} questions — use letters (A,B,C,D,E) or numbers (0-4). e.g. A,B,C,D or 0,1,2,3</p>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="mt-16 glass-effect border-t">
        <div className="mx-auto w-full max-w-7xl px-4 md:px-6 py-6 text-sm text-gray-700 flex items-center justify-between flex-wrap gap-3">
          <div>© {new Date().getFullYear()} Navya-Netra OMR</div>
          <div>React • Tailwind • Gemini AI Vision</div>
        </div>
      </footer>

      {/* MODAL: CAMERA — AI-Powered */}
      <Modal open={openCam} onClose={() => {
        setOpenCam(false);
        resetCameraState();
      }} title="AI Camera OMR Scanner">
        <div className="grid gap-4">
          {/* AI Status Indicator */}
          <div className={`rounded-xl border p-3 ${
            aiStatus.available && aiStatus.aiConfigured
              ? "bg-green-50 border-green-200"
              : "bg-red-50 border-red-200"
          }`}>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${
                aiStatus.available && aiStatus.aiConfigured ? "bg-green-500" : "bg-red-500"
              }`} />
              <span className={`text-sm font-medium ${
                aiStatus.available && aiStatus.aiConfigured ? "text-green-800" : "text-red-800"
              }`}>
                {aiStatus.available && aiStatus.aiConfigured
                  ? "AI Vision Ready — Gemini connected"
                  : `AI Not Ready — ${aiStatus.reason}`}
              </span>
            </div>
          </div>

          {/* Multi-Session Control */}
          {!multiSessionMode ? (
            <div className="rounded-xl border p-3 sm:p-4 bg-blue-50">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                <div>
                  <h3 className="text-base sm:text-lg font-semibold">Scanning Options</h3>
                  <p className="text-xs sm:text-sm text-gray-600">Choose how you want to scan students</p>
                </div>
                <button className="btn-primary text-sm w-full sm:w-auto" onClick={startMultiSession}>
                  Start Multi-Session
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Multi-Session: Scan multiple students sequentially and download all results in one Excel file.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border p-3 sm:p-4 bg-green-50">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                <div>
                  <h3 className="text-base sm:text-lg font-semibold">Multi-Session Active</h3>
                  <p className="text-xs sm:text-sm text-gray-600">
                    Student {currentSessionResults.length + 1} • {currentSessionResults.length} scanned
                  </p>
                </div>
                <div className="flex gap-2 w-full sm:w-auto">
                  <button className="btn-secondary text-xs sm:text-sm flex-1 sm:flex-none" onClick={finishMultiSession}>
                    Finish
                  </button>
                  {currentSessionResults.length > 0 && (
                    <button className="btn-primary text-xs sm:text-sm flex-1 sm:flex-none" onClick={downloadMultiSessionExcel}>
                      Download Excel
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Student Name Input */}
          <div className="rounded-xl border p-4 bg-white">
            <label className="text-sm font-medium">
              {multiSessionMode ? `Student ${currentSessionResults.length + 1} - Name` : 'Student Name (Optional)'}
            </label>
            <input
              className="mt-2 h-10 w-full rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              placeholder={multiSessionMode ? `Enter name for student ${currentSessionResults.length + 1}` : "Enter student name (optional)"}
            />
            {!multiSessionMode && (
              <p className="text-xs text-gray-500 mt-1">Leave blank to use auto-generated name</p>
            )}
          </div>

          {/* Live video + captured photo preview — stacks on mobile */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Live Camera Panel */}
            <div className="rounded-xl border p-2 sm:p-3 bg-white/60">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] sm:text-xs text-gray-500">Live Camera</div>
                <div className="text-[10px] sm:text-xs">
                  {videoReady ? (
                    <span className="text-green-600">● Ready</span>
                  ) : (
                    <span className="text-amber-600">● Starting...</span>
                  )}
                </div>
              </div>
              <div className={`relative ${captureStep !== 'live' ? 'opacity-40' : ''}`}>
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  autoPlay
                  className="w-full rounded-lg bg-black"
                  style={{ minHeight: 200 }}
                />
                {captureStep !== 'live' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg pointer-events-none">
                    <span className="px-3 py-1.5 rounded-full bg-white text-xs font-semibold">
                      {captureStep === 'preview' ? 'Preview locked — Retake to re-capture' : 'Results shown →'}
                    </span>
                  </div>
                )}
              </div>

              {/* Capture button — shown when in live step */}
              {captureStep === 'live' && (
                <button
                  className="mt-3 w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-base shadow-md disabled:opacity-50 disabled:cursor-not-allowed transition"
                  onClick={captureCameraPhoto}
                  disabled={!videoReady}
                >
                  {videoReady ? '📸 Capture Photo' : 'Waiting for camera...'}
                </button>
              )}
            </div>

            {/* Captured Photo / Results Preview Panel */}
            <div className="rounded-xl border p-2 sm:p-3 bg-white/60">
              <div className="text-[10px] sm:text-xs text-gray-500 mb-1">
                {captureStep === 'live' && 'Preview (appears after capture)'}
                {captureStep === 'preview' && 'Captured Photo — Verify it is clear'}
                {captureStep === 'results' && 'AI Scan Results'}
              </div>

              {captureStep === 'live' && (
                <div className="aspect-[4/3] grid place-items-center bg-gray-100 rounded-lg text-gray-400 text-sm text-center px-4">
                  <div>
                    <div className="text-3xl mb-2">📷</div>
                    Click "Capture Photo" to take a picture of the OMR sheet
                  </div>
                </div>
              )}

              {capturedPhoto && captureStep === 'preview' && (
                <img
                  src={capturedPhoto}
                  alt="Captured OMR"
                  className="w-full h-auto rounded-lg border bg-white"
                />
              )}

              {/* Canvas: always mounted when we have a captured photo so drawAIResultOverlay can draw on it */}
              <canvas
                ref={canvasCamRef}
                onClick={() => captureStep === 'results'
                  && openImageZoom(canvasCamRef.current?.toDataURL("image/png"))}
                title="Click to preview full screen"
                className={`w-full h-auto rounded-lg border bg-white ${captureStep === 'results' ? 'cursor-zoom-in' : 'hidden'}`}
              />
              {captureStep === 'results' && (
                <div className="mt-1 text-center text-xs text-gray-500">
                  Tap the image above to preview it full screen
                </div>
              )}

              {captureStep === 'preview' && (
                <>
                  {/* Crop tools — improves accuracy drastically before AI scan */}
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button
                      className="py-2 rounded-xl border-2 border-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 font-semibold text-xs sm:text-sm disabled:opacity-50"
                      onClick={autoCropCameraPhoto}
                      disabled={aiProcessing || autoCropping || !cvReady}
                      title="Automatically detect OMR sheet edges and crop"
                    >
                      {autoCropping ? 'Auto-cropping…' : '✨ Auto-Crop (OpenCV)'}
                    </button>
                    <button
                      className="py-2 rounded-xl border-2 border-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 font-semibold text-xs sm:text-sm disabled:opacity-50"
                      onClick={openManualCropCamera}
                      disabled={aiProcessing || !cvReady}
                      title="Manually drag corners to define the sheet"
                    >
                      ✂️ Manual Crop
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-500 mt-1 px-1">
                    Tip: Crop to just the OMR sheet area for best AI accuracy. Auto-Crop uses contour detection; Manual Crop lets you drag 4 corner handles.
                  </p>

                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button
                      className="py-2.5 rounded-xl border-2 border-gray-300 hover:bg-gray-50 font-semibold text-sm"
                      onClick={retakePhoto}
                      disabled={aiProcessing}
                    >
                      ↻ Retake
                    </button>
                    <button
                      className="py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-white font-semibold text-sm shadow-md disabled:opacity-50"
                      onClick={captureAndGrade}
                      disabled={aiProcessing || !aiStatus.available || !aiStatus.aiConfigured}
                    >
                      {aiProcessing ? 'Scanning...' : '✓ Scan with AI'}
                    </button>
                  </div>
                </>
              )}

              {captureStep === 'results' && (
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <button
                    className="py-2.5 rounded-xl border-2 border-gray-300 hover:bg-gray-50 font-semibold text-sm"
                    onClick={retakePhoto}
                  >
                    ↻ New Scan
                  </button>
                  <button
                    className="py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-md"
                    onClick={captureAndGrade}
                    disabled={aiProcessing}
                  >
                    Re-scan
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Progress Banner */}
          {aiProcessing && (
            <div className="rounded-xl border p-3 bg-blue-50 border-blue-200">
              <div className="flex items-center gap-2 text-sm text-blue-800">
                <span className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                AI is reading the OMR sheet... This takes 3-8 seconds.
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4">
            <div className="rounded-xl border p-3 sm:p-4 bg-white">
              <div className="text-sm text-gray-600">
                Camera: {camError
                  ? <span className="text-red-600">Error — {camError}</span>
                  : (videoReady ? <span className="text-green-600">Ready</span> : "Starting...")}
              </div>

              {devices.length > 1 && (
                <label className="grid gap-1 mt-2">
                  <span className="text-sm font-medium">Camera</span>
                  <select
                    className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                    value={selectedDeviceId || ""}
                    onChange={(e) => startCamera(e.target.value)}
                  >
                    {devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${d.deviceId.slice(0, 4)}...`}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <label className="grid gap-1">
                  <span className="text-sm font-medium">Questions</span>
                  <input
                    type="number"
                    min="1"
                    value={numberOfQuestions}
                    onChange={(e) => setNumberOfQuestions(e.target.value)}
                    className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-sm font-medium">Answer Key</span>
                  <input
                    className="h-10 w-full rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                    value={answerKeyText}
                    onChange={(e) => setAnswerKeyText(e.target.value)}
                    placeholder={`e.g. ${Array.from({length: Math.min(parseInt(numberOfQuestions) || 5, 10)}, (_, i) => i % 5).join(",")}`}
                  />
                </label>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Comma-separated answers — use letters (A,B,C,D,E) or numbers (0-4). e.g. A,C,B,D … Supports any number of questions — 10, 50, 100+.
              </p>

              {/* Save Results Buttons — only shown after scan results */}
              {captureStep === 'results' && (
                <>
                  {multiSessionMode ? (
                    <button
                      className="btn-primary mt-3 w-full bg-purple-600 hover:bg-purple-700"
                      onClick={saveCurrentStudentResult}
                      disabled={!picked.length || !studentName.trim()}
                    >
                      ✓ Save Student {currentSessionResults.length + 1} & Next →
                    </button>
                  ) : (
                    <button
                      className="btn-primary mt-3 w-full bg-green-600 hover:bg-green-700"
                      onClick={saveSingleStudentResult}
                      disabled={!picked.length}
                    >
                      ✓ Save Result & New Scan
                    </button>
                  )}
                </>
              )}

              <div className="mt-3">
                <ScoreBar score={score} />
                <div className="mt-2 text-sm break-words">AI Detected: <b>[{picked.join(", ")}]</b></div>

                {/* AI Notes */}
                {aiNotes && (
                  <div className="mt-2 p-2 rounded bg-gray-50 text-xs text-gray-600">
                    AI Notes: {aiNotes}
                  </div>
                )}

                {/* Marks Display */}
                <div className="mt-3 p-2 sm:p-3 bg-gray-50 rounded-lg">
                  <h4 className="font-medium text-sm mb-2">Marks Calculation:</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                    <div>Correct: <b className="text-green-600">{currentMarks.correctAnswers}</b></div>
                    <div>Wrong: <b className="text-red-600">{currentMarks.wrongAnswers}</b></div>
                    <div>Unanswered: <b className="text-gray-500">{currentMarks.unanswered}</b></div>
                    <div>Marks Obtained: <b>{currentMarks.marksObtained.toFixed(2)}</b></div>
                    <div>Maximum Marks: <b>{currentMarks.maximumMarks}</b></div>
                    <div>Percentage: <b>{currentMarks.percentage}%</b></div>
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* Camera Results Section */}
          {(cameraResults.length > 0 || multiSessionMode) && (
            <div className="rounded-xl border p-4 bg-white">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold">
                  {multiSessionMode ? 'Current Session Results' : 'All Camera Results'}
                  ({multiSessionMode ? currentSessionResults.length : cameraResults.length} student{(multiSessionMode ? currentSessionResults.length : cameraResults.length) !== 1 ? 's' : ''})
                </h3>
                {cameraResults.length > 0 && (
                  <div className="flex gap-2">
                    <button className="btn-primary text-sm" onClick={downloadCameraResultsExcel}>
                      Download All Excel
                    </button>
                    <button className="btn-secondary text-sm bg-red-600 hover:bg-red-700" onClick={clearCameraResults}>
                      Clear All
                    </button>
                  </div>
                )}
              </div>

              {(multiSessionMode ? currentSessionResults.length : cameraResults.length) > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {(multiSessionMode ? currentSessionResults : cameraResults).map((result) => (
                    <CameraResultCard
                      key={result.id}
                      result={result}
                      showStudentNumber={multiSessionMode}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  No students scanned yet. Start scanning to see results here.
                </div>
              )}
            </div>
          )}

          <ResultsTable picked={picked} answerKey={AK} />
        </div>
      </Modal>

      {/* MODAL: MULTI-UPLOAD — AI-Powered */}
      <Modal open={openUpload} onClose={() => setOpenUpload(false)} title="AI Upload OMR Scanner">
        <div className="grid gap-3 sm:gap-4">
          {/* AI Status */}
          <div className={`rounded-xl border p-2 sm:p-3 ${
            aiStatus.available && aiStatus.aiConfigured
              ? "bg-green-50 border-green-200"
              : "bg-red-50 border-red-200"
          }`}>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full ${
                aiStatus.available && aiStatus.aiConfigured ? "bg-green-500" : "bg-red-500"
              }`} />
              <span className={`text-xs sm:text-sm font-medium ${
                aiStatus.available && aiStatus.aiConfigured ? "text-green-800" : "text-red-800"
              }`}>
                {aiStatus.available && aiStatus.aiConfigured
                  ? "AI Vision Ready — Gemini connected"
                  : `AI Not Ready — ${aiStatus.reason}`}
              </span>
            </div>
          </div>

          {/* Multi-Session Control */}
          {!uploadMultiSession ? (
            <div className="rounded-xl border p-3 sm:p-4 bg-blue-50">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                <div>
                  <h3 className="text-base sm:text-lg font-semibold">Scanning Options</h3>
                  <p className="text-xs sm:text-sm text-gray-600">Upload one student or multiple in one session.</p>
                </div>
                <button className="btn-primary text-sm w-full sm:w-auto" onClick={startUploadMultiSession}>
                  Start Multi-Session
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Multi-Session: Upload one student at a time (with name), then another, etc. Download all results in one Excel file.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border p-3 sm:p-4 bg-green-50">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                <div>
                  <h3 className="text-base sm:text-lg font-semibold">Multi-Session Active</h3>
                  <p className="text-xs sm:text-sm text-gray-600">
                    Student {uploadCurrentSession.length + 1} • {uploadCurrentSession.length} uploaded
                  </p>
                </div>
                <div className="flex gap-2 w-full sm:w-auto">
                  <button className="btn-secondary text-xs sm:text-sm flex-1 sm:flex-none" onClick={finishUploadMultiSession}>
                    Finish
                  </button>
                  {uploadCurrentSession.length > 0 && (
                    <button className="btn-primary text-xs sm:text-sm flex-1 sm:flex-none" onClick={downloadUploadSessionExcel}>
                      Download Excel
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Student Name Input (multi-session) */}
          {uploadMultiSession && (
            <div className="rounded-xl border p-3 sm:p-4 bg-white">
              <label className="text-sm font-medium">
                Student {uploadCurrentSession.length + 1} - Name
              </label>
              <input
                className="mt-2 h-10 w-full rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                value={uploadStudentName}
                onChange={(e) => setUploadStudentName(e.target.value)}
                placeholder={`Enter name for student ${uploadCurrentSession.length + 1}`}
              />
              <p className="text-xs text-gray-500 mt-1">Enter the name, then upload this student's OMR image(s) below.</p>
            </div>
          )}

          <div className="rounded-xl border p-3 sm:p-4 bg-white">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-4">
              <label className="grid gap-1">
                <span className="text-sm font-medium">No. of Questions</span>
                <input
                  type="number"
                  min="1"
                  max="500"
                  value={numberOfQuestions}
                  onChange={(e) => setNumberOfQuestions(e.target.value)}
                  className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>

              <label className="grid gap-1">
                <span className="text-sm font-medium">Marks per Question</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={marksPerQuestion}
                  onChange={(e) => setMarksPerQuestion(e.target.value)}
                  className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>

              <label className="grid gap-1">
                <span className="text-sm font-medium">Negative Marks</span>
                <input
                  type="number"
                  step="0.25"
                  min="0"
                  value={negativeMarks}
                  onChange={(e) => setNegativeMarks(e.target.value)}
                  className="h-10 rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>

              <label className="grid gap-1">
                <span className="text-sm font-medium">Total Marks</span>
                <input
                  type="number"
                  value={totalMarks}
                  readOnly
                  className="h-10 rounded-lg border px-3 bg-gray-50 outline-none"
                />
              </label>
            </div>

            <label className="text-sm font-medium">Answer Key</label>
            <input
              className="mt-2 h-10 w-full rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
              value={answerKeyText}
              onChange={(e) => setAnswerKeyText(e.target.value)}
            />
            <div className="mt-3 grid gap-2">
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={onFiles}
                disabled={busyUp || !aiStatus.available || !aiStatus.aiConfigured}
                className="text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary text-xs sm:text-sm flex-1 sm:flex-none" onClick={clearUploads} disabled={!batchResults.length}>
                  Clear
                </button>
                <button type="button" className="btn-primary text-xs sm:text-sm flex-1 sm:flex-none" onClick={downloadExcelForUploads} disabled={!batchResults.length}>
                  Excel
                </button>
                <button
                  type="button"
                  className="btn-primary bg-purple-600 hover:bg-purple-700 text-xs sm:text-sm flex-1 sm:flex-none"
                  onClick={() => setShowVisualization(true)}
                  disabled={!batchResults.length}
                >
                  Charts
                </button>
              </div>
            </div>

            {/* Upload Progress */}
            {busyUp && (
              <div className="mt-3 p-3 rounded-lg bg-blue-50 border border-blue-200">
                <div className="flex items-center gap-2 text-sm text-blue-800">
                  <span className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  AI processing image {uploadProgress.current} of {uploadProgress.total}...
                </div>
                <div className="mt-2 w-full bg-blue-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {!busyUp && !aiStatus.available && (
              <div className="mt-2 text-sm text-red-600">
                Start the AI backend server first: <code className="px-1 py-0.5 bg-red-50 rounded">npm run server</code>
              </div>
            )}
          </div>

          {/* Results grid */}
          {batchResults.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {batchResults.map((r) => (
                <UploadResultCard key={r.id} result={r} />
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-600">
              No results yet. Choose one or more marksheet images above.
            </div>
          )}
        </div>
      </Modal>

      {/* MODAL: RESULTS VISUALIZATION */}
      <Modal
        open={showVisualization}
        onClose={() => setShowVisualization(false)}
        title="Results Visualization & Analytics"
        size="xl"
      >
        <div className="max-h-[80vh] overflow-y-auto">
          <ResultsVisualization
            results={batchResults}
            examConfig={{
              numberOfQuestions: parseInt(numberOfQuestions),
              marksPerQuestion: parseFloat(marksPerQuestion),
              negativeMarks: parseFloat(negativeMarks),
              totalMarks: parseFloat(totalMarks),
              answerKey: AK
            }}
          />
        </div>
      </Modal>

      {/* MODAL: THEORY PAPER SCANNING */}
      <Modal open={openTheory} onClose={() => { setOpenTheory(false); stopTheoryCamera(); stopQPaperCamera(); }} title="AI Theory Paper Evaluator">
        <div className="grid gap-4">
          {/* AI Status */}
          <div className={`rounded-xl border p-3 ${
            aiStatus.available && aiStatus.aiConfigured ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
          }`}>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${aiStatus.available && aiStatus.aiConfigured ? "bg-green-500" : "bg-red-500"}`} />
              <span className={`text-sm font-medium ${aiStatus.available && aiStatus.aiConfigured ? "text-green-800" : "text-red-800"}`}>
                {aiStatus.available && aiStatus.aiConfigured ? "AI Ready" : `AI Not Ready — ${aiStatus.reason}`}
              </span>
            </div>
          </div>

          {/* Step Indicator */}
          <div className="flex items-center gap-3">
            <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${theoryStep === 1 ? "bg-indigo-50 border-indigo-300" : extractedQuestions.length ? "bg-green-50 border-green-300" : "bg-gray-50"}`}>
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${theoryStep === 1 ? "bg-indigo-600 text-white" : extractedQuestions.length ? "bg-green-600 text-white" : "bg-gray-300 text-gray-600"}`}>
                {extractedQuestions.length ? "✓" : "1"}
              </span>
              <span className="text-sm font-medium">Upload Question Paper</span>
            </div>
            <div className="w-8 h-0.5 bg-gray-300" />
            <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${theoryStep === 2 ? "bg-indigo-50 border-indigo-300" : "bg-gray-50"}`}>
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${theoryStep === 2 ? "bg-indigo-600 text-white" : "bg-gray-300 text-gray-600"}`}>2</span>
              <span className="text-sm font-medium">Upload Answer Sheets</span>
            </div>

            {(extractedQuestions.length > 0 || theoryResults.length > 0) && (
              <button className="ml-auto text-xs text-red-500 hover:text-red-700" onClick={resetTheory}>
                Start Over
              </button>
            )}
          </div>

          {/* STEP 1: Upload / Capture Question Paper */}
          {theoryStep === 1 && (
            <div className="rounded-xl border p-4 sm:p-5 bg-white">
              <h3 className="text-lg font-semibold mb-1">Step 1: Question Paper</h3>
              <p className="text-sm text-gray-600 mb-3">Upload a file OR click photo(s) of the question paper using your camera. AI will extract all questions.</p>

              {/* Mode switcher */}
              <div className="flex gap-2 mb-4 bg-gray-100 p-1 rounded-lg w-full sm:w-fit">
                <button
                  className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 text-sm font-medium rounded-md transition ${qPaperInputMode === 'upload' ? 'bg-white shadow text-indigo-700' : 'text-gray-600 hover:text-gray-800'}`}
                  onClick={() => setQPaperInputMode('upload')}
                >
                  📁 Upload File
                </button>
                <button
                  className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 text-sm font-medium rounded-md transition ${qPaperInputMode === 'camera' ? 'bg-white shadow text-indigo-700' : 'text-gray-600 hover:text-gray-800'}`}
                  onClick={() => setQPaperInputMode('camera')}
                >
                  📷 Use Camera
                </button>
              </div>

              {qPaperInputMode === 'upload' && (
                <>
                  <input
                    type="file"
                    accept="image/*,.docx,.doc,.txt,.pdf"
                    onChange={onQuestionPaperUpload}
                    disabled={extractingQuestions || !aiStatus.available || !aiStatus.aiConfigured}
                    className="mb-3 w-full text-sm"
                  />
                  <div className="flex flex-wrap gap-2 mb-3">
                    <span className="text-[10px] px-2 py-1 bg-blue-50 text-blue-700 rounded-full">JPG/PNG</span>
                    <span className="text-[10px] px-2 py-1 bg-purple-50 text-purple-700 rounded-full">Word (.docx)</span>
                    <span className="text-[10px] px-2 py-1 bg-red-50 text-red-700 rounded-full">PDF</span>
                    <span className="text-[10px] px-2 py-1 bg-gray-50 text-gray-700 rounded-full">Text (.txt)</span>
                  </div>
                </>
              )}

              {qPaperInputMode === 'camera' && (
                <div className="grid gap-3">
                  <div className="rounded-xl border bg-white/60 p-2 sm:p-3">
                    <div className="text-[10px] sm:text-xs text-gray-500 mb-1">Live Camera — Question Paper</div>
                    <video ref={qPaperVideoRef} playsInline muted autoPlay className="w-full rounded-lg bg-black" style={{ minHeight: 200 }} />
                    <button
                      className="mt-3 w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow-md disabled:opacity-50"
                      onClick={captureQPaperPage}
                      disabled={!qPaperCamReady}
                    >
                      📸 Capture Page {qPaperCapturedPages.length + 1}
                    </button>
                  </div>

                  {qPaperCapturedPages.length > 0 && (
                    <div className="rounded-xl border bg-white p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-sm font-semibold">Captured Pages ({qPaperCapturedPages.length})</div>
                        <button className="text-xs text-red-600 hover:text-red-800" onClick={() => setQPaperCapturedPages([])}>Clear all</button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                        {qPaperCapturedPages.map((src, i) => (
                          <div key={i} className="relative group">
                            <img src={src} alt={`Q-paper page ${i+1}`} className="w-full h-28 sm:h-32 object-cover rounded-md border" />
                            <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">P{i+1}</div>
                            <button
                              className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center bg-red-600 text-white text-xs rounded-full opacity-80 hover:opacity-100"
                              onClick={() => removeQPaperCapturedPage(i)}
                              title="Remove page"
                            >×</button>
                            <div className="absolute bottom-1 left-1 right-1 flex gap-1">
                              <button
                                className="flex-1 text-[10px] px-1 py-0.5 bg-indigo-600/90 hover:bg-indigo-700 text-white rounded"
                                onClick={() => autoCropQPaperPage(i)}
                                title="Auto-crop sheet"
                              >✨ Auto</button>
                              <button
                                className="flex-1 text-[10px] px-1 py-0.5 bg-indigo-600/90 hover:bg-indigo-700 text-white rounded"
                                onClick={() => openManualCropQPaper(i)}
                                title="Manual crop"
                              >✂️ Crop</button>
                            </div>
                          </div>
                        ))}
                      </div>
                      <button
                        className="mt-3 w-full py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white font-semibold shadow-md disabled:opacity-50"
                        onClick={extractQPaperFromCamera}
                        disabled={extractingQuestions || !qPaperCapturedPages.length}
                      >
                        {extractingQuestions ? 'Extracting Questions...' : '✓ Extract Questions with AI'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {extractingQuestions && (
                <div className="mt-3 p-3 rounded-lg bg-blue-50 border border-blue-200">
                  <div className="flex items-center gap-2 text-sm text-blue-800">
                    <span className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    AI is reading the question paper and extracting questions...
                  </div>
                </div>
              )}

              {questionPaperPreview && !extractingQuestions && extractedQuestions.length === 0 && (
                <div className="mt-3">
                  <img src={questionPaperPreview} alt="Question paper" className="w-full max-h-60 object-contain rounded-lg border" />
                </div>
              )}
            </div>
          )}

          {/* Extracted Questions Display (shown in step 2) */}
          {theoryStep === 2 && extractedQuestions.length > 0 && (
            <>
              <div className="rounded-xl border p-4 bg-indigo-50">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="text-lg font-semibold">Extracted Questions ({extractedQuestions.length})</h3>
                  <button className="text-xs text-indigo-600 hover:text-indigo-800" onClick={() => setTheoryStep(1)}>
                    Change Question Paper
                  </button>
                </div>
                <div className="grid gap-2 max-h-48 overflow-y-auto">
                  {extractedQuestions.map((q, i) => (
                    <div key={i} className="flex gap-2 p-2 bg-white rounded-lg border text-sm">
                      <span className="font-bold text-indigo-600 shrink-0">Q{q.number || (i + 1)}.</span>
                      <span className="text-gray-800">{q.text}</span>
                      {q.marks && <span className="ml-auto shrink-0 text-xs text-gray-500">[{q.marks}m]</span>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Multi-Session Control */}
              {!theoryMultiSession ? (
                <div className="rounded-xl border p-3 sm:p-4 bg-blue-50">
                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                    <div>
                      <h3 className="text-base sm:text-lg font-semibold">Scanning Options</h3>
                      <p className="text-xs sm:text-sm text-gray-600">Scan one student or multiple in one session.</p>
                    </div>
                    <button className="btn-primary text-sm w-full sm:w-auto" onClick={startTheoryMultiSession}>
                      Start Multi-Session
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border p-3 sm:p-4 bg-green-50">
                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                    <div>
                      <h3 className="text-base sm:text-lg font-semibold">Multi-Session Active</h3>
                      <p className="text-xs sm:text-sm text-gray-600">
                        Student {theoryCurrentSession.length + 1} • {theoryCurrentSession.length} evaluated
                      </p>
                    </div>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <button className="btn-secondary text-xs sm:text-sm flex-1 sm:flex-none" onClick={finishTheoryMultiSession}>
                        Finish
                      </button>
                      {theoryCurrentSession.length > 0 && (
                        <button className="btn-primary text-xs sm:text-sm flex-1 sm:flex-none" onClick={downloadTheoryMultiSessionExcel}>
                          Download Excel
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Student Name Input */}
              <div className="rounded-xl border p-3 sm:p-4 bg-white">
                <label className="text-sm font-medium">
                  {theoryMultiSession ? `Student ${theoryCurrentSession.length + 1} - Name` : 'Student Name (Optional)'}
                </label>
                <input
                  className="mt-2 h-10 w-full rounded-lg border px-3 outline-none focus:ring-2 focus:ring-indigo-500"
                  value={theoryStudentName}
                  onChange={(e) => setTheoryStudentName(e.target.value)}
                  placeholder={theoryMultiSession ? `Enter name for student ${theoryCurrentSession.length + 1}` : "Enter student name (optional)"}
                />
              </div>

              {/* STEP 2: Capture / Upload Answer Sheets */}
              <div className="rounded-xl border p-4 sm:p-5 bg-white">
                <h3 className="text-lg font-semibold mb-1">Step 2: Student's Answer Sheet</h3>
                <p className="text-sm text-gray-600 mb-3">Capture photos with the camera OR upload files. All pages will be read as one continuous answer sheet.</p>

                {/* Mode switcher */}
                <div className="flex gap-2 mb-4 bg-gray-100 p-1 rounded-lg w-full sm:w-fit">
                  <button
                    className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 text-sm font-medium rounded-md transition ${theoryInputMode === 'upload' ? 'bg-white shadow text-indigo-700' : 'text-gray-600 hover:text-gray-800'}`}
                    onClick={() => setTheoryInputMode('upload')}
                  >
                    📁 Upload Files
                  </button>
                  <button
                    className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 text-sm font-medium rounded-md transition ${theoryInputMode === 'camera' ? 'bg-white shadow text-indigo-700' : 'text-gray-600 hover:text-gray-800'}`}
                    onClick={() => setTheoryInputMode('camera')}
                  >
                    📷 Use Camera
                  </button>
                </div>

                {theoryInputMode === 'upload' && (
                  <div className="flex flex-wrap gap-2 items-center">
                    <input
                      type="file"
                      accept="image/*,.docx,.doc,.txt"
                      multiple
                      onChange={onAnswerSheetUpload}
                      disabled={theoryProcessing}
                      className="text-sm"
                    />
                    {theoryResults.length > 0 && (
                      <>
                        <button className="btn-secondary text-xs sm:text-sm" onClick={() => setTheoryResults([])}>
                          Clear Results
                        </button>
                        <button className="btn-primary text-xs sm:text-sm" onClick={downloadTheoryExcel}>
                          Download Excel
                        </button>
                      </>
                    )}
                  </div>
                )}

                {theoryInputMode === 'camera' && (
                  <div className="grid gap-3">
                    <div className="rounded-xl border bg-white/60 p-2 sm:p-3">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[10px] sm:text-xs text-gray-500">Live Camera — Answer Sheet</div>
                        <div className="text-[10px] sm:text-xs">
                          {theoryCamReady ? <span className="text-green-600">● Ready</span> : <span className="text-amber-600">● Starting...</span>}
                        </div>
                      </div>
                      <video ref={theoryVideoRef} playsInline muted autoPlay className="w-full rounded-lg bg-black" style={{ minHeight: 200 }} />
                      {theoryCamError && <div className="mt-2 text-xs text-red-600">{theoryCamError}</div>}
                      <button
                        className="mt-3 w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow-md disabled:opacity-50"
                        onClick={captureTheoryPage}
                        disabled={!theoryCamReady}
                      >
                        📸 Capture Page {theoryCapturedPages.length + 1}
                      </button>
                    </div>

                    {theoryCapturedPages.length > 0 && (
                      <div className="rounded-xl border bg-white p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm font-semibold">Captured Pages ({theoryCapturedPages.length})</div>
                          <button className="text-xs text-red-600 hover:text-red-800" onClick={() => setTheoryCapturedPages([])}>Clear all</button>
                        </div>
                        <p className="text-xs text-gray-500 mb-2">Verify each page. Use ✨ Auto or ✂️ Manual to crop to the paper, × to remove.</p>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                          {theoryCapturedPages.map((src, i) => (
                            <div key={i} className="relative group">
                              <img src={src} alt={`Answer page ${i+1}`} className="w-full h-28 sm:h-32 object-cover rounded-md border" />
                              <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">P{i+1}</div>
                              <button
                                className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center bg-red-600 text-white text-xs rounded-full opacity-80 hover:opacity-100"
                                onClick={() => removeTheoryCapturedPage(i)}
                                title="Remove page"
                              >×</button>
                              <div className="absolute bottom-1 left-1 right-1 flex gap-1">
                                <button
                                  className="flex-1 text-[10px] px-1 py-0.5 bg-indigo-600/90 hover:bg-indigo-700 text-white rounded"
                                  onClick={() => autoCropTheoryPage(i)}
                                  title="Auto-crop sheet"
                                >✨ Auto</button>
                                <button
                                  className="flex-1 text-[10px] px-1 py-0.5 bg-indigo-600/90 hover:bg-indigo-700 text-white rounded"
                                  onClick={() => openManualCropTheory(i)}
                                  title="Manual crop"
                                >✂️ Crop</button>
                              </div>
                            </div>
                          ))}
                        </div>
                        <button
                          className="mt-3 w-full py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white font-semibold shadow-md disabled:opacity-50"
                          onClick={scanCapturedTheoryPages}
                          disabled={theoryProcessing || !theoryCapturedPages.length}
                        >
                          {theoryProcessing ? 'AI Evaluating...' : (theoryMultiSession ? `✓ Scan & Save Student ${theoryCurrentSession.length + 1}` : '✓ Scan Answer Sheet with AI')}
                        </button>
                      </div>
                    )}

                    {theoryResults.length > 0 && (
                      <div className="flex flex-wrap gap-2 items-center">
                        <button className="btn-secondary text-xs sm:text-sm" onClick={() => setTheoryResults([])}>
                          Clear Results
                        </button>
                        <button className="btn-primary text-xs sm:text-sm" onClick={downloadTheoryExcel}>
                          Download Excel
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Progress */}
                {theoryProcessing && (
                  <div className="mt-3 p-3 rounded-lg bg-blue-50 border border-blue-200">
                    <div className="flex items-center gap-2 text-sm text-blue-800">
                      <span className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                      AI evaluating answer sheet...
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Results */}
          {theoryResults.length > 0 && (
            <div className="grid gap-4">
              {theoryResults.map((r) => (
                <TheoryResultCard key={r.id} result={r} />
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* Global Image Cropper — used by Camera OMR, Theory pages, Q-paper pages */}
      <ImageCropper
        open={cropperOpen}
        image={cropperImage}
        onCancel={handleCropperCancel}
        onApply={handleCropperApply}
      />
    </>
  );
}

function ServiceCard({ title, desc, cta, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-left glass-effect border rounded-3xl p-6 card-hover disabled:opacity-50"
    >
      <h3 className="text-xl font-semibold">{title}</h3>
      <p className="mt-2 text-gray-700">{desc}</p>
      <div className="mt-4 inline-flex items-center gap-2 text-indigo-700 font-medium">
        {cta} <span>→</span>
      </div>
    </button>
  );
}

function CameraResultCard({ result, showStudentNumber = false }) {
  const { name, score, picked, previewUrl, marksObtained, maximumMarks, correctAnswers, wrongAnswers, unanswered, percentage, timestamp, studentNumber } = result;

  return (
    <div className="rounded-2xl border bg-white overflow-hidden">
      <div className="p-3 border-b bg-gradient-to-r from-blue-50 to-purple-50">
        <div className="flex justify-between items-start">
          <div>
            <div className="text-sm font-medium truncate" title={name}>{name}</div>
            {showStudentNumber && (
              <div className="text-xs text-gray-600 mt-1">Student #{studentNumber}</div>
            )}
          </div>
          {showStudentNumber && (
            <span className="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded-full">#{studentNumber}</span>
          )}
        </div>
        <div className="text-xs text-gray-600 flex justify-between mt-1">
          <span>Score: <b>{percentage}%</b></span>
          <span>Marks: <b>{marksObtained?.toFixed(2) || '0'}/{maximumMarks || '0'}</b></span>
        </div>
        <div className="text-xs text-gray-500 mt-1">{timestamp}</div>
      </div>
      <div className="p-3">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={name}
            onClick={() => openImageZoom(previewUrl)}
            title="Click to preview full screen"
            className="w-full h-auto rounded-lg border cursor-zoom-in"
          />
        ) : (
          <div className="text-sm text-red-600">No preview available</div>
        )}
        {picked?.length ? (
          <div className="mt-2 text-xs text-gray-700">
            <div>AI Detected: <b>[{picked.join(", ")}]</b></div>
            <div className="grid grid-cols-3 gap-1 mt-1">
              <span className="text-green-600">✓ {correctAnswers}</span>
              <span className="text-red-600">✗ {wrongAnswers}</span>
              <span className="text-gray-500">? {unanswered}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TheoryResultCard({ result }) {
  const { name, answers, overallAccuracy, handwritingQuality, notes, error, previewUrl, timestamp } = result;

  if (error) {
    return (
      <div className="rounded-2xl border bg-white overflow-hidden">
        <div className="p-4 border-b bg-red-50">
          <div className="text-sm font-medium">{name}</div>
          <div className="text-xs text-red-600 mt-1">Error: {error}</div>
        </div>
      </div>
    );
  }

  function accuracyColor(pct) {
    if (pct >= 70) return { bg: "bg-green-500", text: "text-green-700", light: "bg-green-50" };
    if (pct >= 40) return { bg: "bg-amber-500", text: "text-amber-700", light: "bg-amber-50" };
    return { bg: "bg-red-500", text: "text-red-700", light: "bg-red-50" };
  }

  const overallColor = accuracyColor(overallAccuracy || 0);

  return (
    <div className="rounded-2xl border bg-white overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b bg-gradient-to-r from-purple-50 to-indigo-50">
        <div className="flex justify-between items-start">
          <div>
            <div className="text-sm font-medium">{name}</div>
            <div className="text-xs text-gray-500 mt-1">{timestamp}</div>
          </div>
          <div className="text-right">
            <div className={`text-2xl font-black ${overallColor.text}`}>
              {overallAccuracy ?? 0}%
            </div>
            <div className="text-xs text-gray-500">Overall Accuracy</div>
          </div>
        </div>

        {/* Overall accuracy bar */}
        <div className="mt-2 w-full bg-gray-200 rounded-full h-2.5">
          <div className={`h-2.5 rounded-full transition-all ${overallColor.bg}`} style={{ width: `${overallAccuracy || 0}%` }} />
        </div>

        <div className="mt-2 flex gap-3 text-xs text-gray-500">
          {handwritingQuality && <span>Handwriting: <b>{handwritingQuality}</b></span>}
          {notes && <span>{notes}</span>}
        </div>
      </div>

      {/* Per-answer accuracy */}
      <div className="p-4">
        <div className="grid gap-3">
          {(answers || []).map((ans, i) => {
            const color = accuracyColor(ans.accuracyPercent || 0);
            return (
              <div key={i} className="rounded-lg border p-3 bg-gray-50">
                <div className="flex justify-between items-center">
                  <h4 className="text-sm font-semibold">Q{ans.questionNumber || (i + 1)}</h4>
                  <span className={`text-lg font-black ${color.text}`}>{ans.accuracyPercent}%</span>
                </div>

                {/* Accuracy bar */}
                <div className="mt-1 w-full bg-gray-200 rounded-full h-2">
                  <div className={`h-2 rounded-full transition-all ${color.bg}`} style={{ width: `${ans.accuracyPercent}%` }} />
                </div>

                {ans.questionText && (
                  <div className="mt-2 text-xs text-gray-500">
                    <span className="font-medium">Question:</span> {ans.questionText}
                  </div>
                )}

                {ans.studentAnswer && (
                  <div className="mt-1 text-xs text-gray-800 bg-white p-2 rounded border">
                    <span className="font-medium text-gray-500">Student wrote:</span> {ans.studentAnswer}
                  </div>
                )}

                {ans.correctAnswer && (
                  <div className="mt-1 text-xs text-blue-800 bg-blue-50 p-2 rounded">
                    <span className="font-medium">Correct answer:</span> {ans.correctAnswer}
                  </div>
                )}

                <div className="mt-2 grid grid-cols-2 gap-2">
                  {ans.whatWasRight && (
                    <div className="text-xs p-2 bg-green-50 text-green-700 rounded">
                      <span className="font-medium">Correct:</span> {ans.whatWasRight}
                    </div>
                  )}
                  {ans.whatWasMissing && (
                    <div className="text-xs p-2 bg-red-50 text-red-700 rounded">
                      <span className="font-medium">Missing:</span> {ans.whatWasMissing}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Preview — show all pages */}
      {(result.allPreviewUrls?.length > 0 || previewUrl) && (
        <div className="p-3 border-t">
          <details>
            <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
              View uploaded answer sheet ({result.allPreviewUrls?.length || 1} page{(result.allPreviewUrls?.length || 1) > 1 ? "s" : ""})
            </summary>
            <div className="mt-2 grid gap-2">
              {(result.allPreviewUrls || [previewUrl]).map((url, i) => (
                <div key={i}>
                  {(result.allPreviewUrls?.length || 0) > 1 && (
                    <div className="text-[10px] text-gray-400 mb-1">Page {i + 1}</div>
                  )}
                  <img
                    src={url}
                    alt={`${name} page ${i + 1}`}
                    onClick={() => openImageZoom(url)}
                    title="Click to preview full screen"
                    className="w-full h-auto rounded-lg border cursor-zoom-in"
                  />
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

/* --- helpers --- */

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = URL.createObjectURL(file);
  });
}

function UploadResultCard({ result }) {
  const { name, score, picked, previewUrl, error, marksObtained, maximumMarks, correctAnswers, wrongAnswers, unanswered, percentage } = result;
  return (
    <div className="rounded-2xl border bg-white overflow-hidden">
      <div className="p-3 border-b">
        <div className="text-sm font-medium truncate" title={name}>{name}</div>
        <div className="text-xs text-gray-600 flex justify-between mt-1">
          <span>Score: <b>{percentage}%</b></span>
          <span>Marks: <b>{marksObtained?.toFixed(2) || '0'}/{maximumMarks || '0'}</b></span>
        </div>
      </div>
      <div className="p-3">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={name}
            onClick={() => openImageZoom(previewUrl)}
            title="Click to preview full screen"
            className="w-full h-auto rounded-lg border cursor-zoom-in"
          />
        ) : (
          <div className="text-sm text-red-600">{error || "No preview"}</div>
        )}
        {picked?.length ? (
          <div className="mt-2 text-xs text-gray-700">
            <div>AI Detected: <b>[{picked.join(", ")}]</b></div>
            <div className="grid grid-cols-3 gap-1 mt-1">
              <span className="text-green-600">✓ {correctAnswers}</span>
              <span className="text-red-600">✗ {wrongAnswers}</span>
              <span className="text-gray-500">? {unanswered}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
