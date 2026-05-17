import { useEffect, useRef, useState } from 'react'
import ScoreBar from '../components/ScoreBar.jsx'
import ResultsTable from '../components/ResultsTable.jsx'
import { runOMROnMat, drawScoreOnCanvas } from '../utils/omr.js'

export default function CameraOMR() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [score, setScore] = useState(0)
  const [answers, setAnswers] = useState([])
  const [answerKeyText, setAnswerKeyText] = useState('1,2,0,2,4')
  const [busy, setBusy] = useState(false)

  // wait for OpenCV runtime
  useEffect(() => {
    const iv = setInterval(()=>{
      if (window.cv && window.cv.getBuildInformation) {
        setReady(true)
        clearInterval(iv)
      }
    }, 150)
    return ()=>clearInterval(iv)
  }, [])

  useEffect(() => {
    if (!ready) return
    const v = videoRef.current
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => { v.srcObject = stream; v.play() })
      .catch(e => alert('Camera error: ' + e.message))
    return () => {
      const st = videoRef.current?.srcObject
      if (st) st.getTracks().forEach(t => t.stop())
    }
  }, [ready])

  const captureAndGrade = () => {
    if (!ready || busy) return
    setBusy(true)
    const cv = window.cv
    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')

    const w = Math.min(1000, video.videoWidth || 640)
    const h = Math.round((video.videoHeight || 480) * (w / (video.videoWidth || 640)))
    canvas.width = w; canvas.height = h
    ctx.drawImage(video, 0, 0, w, h)

    const src = cv.imread(canvas)
    try {
      const key = answerKeyText.split(',').map(s=>parseInt(s.trim(),10))
      const { scorePct, picked } = runOMROnMat(cv, src, { questions:5, choices:5, answerKey:key })
      setScore(scorePct)
      setAnswers(picked)
      drawScoreOnCanvas(canvas, scorePct, picked, key)
    } catch (e) {
      console.error(e)
      alert('Processing error: ' + e.message + '\nTip: keep sheet flat, good light, fill bubbles.')
    } finally {
      src.delete()
      setBusy(false)
    }
  }

  return (
    <main className="container">
      <div className="card">
        <h2>Live Camera OMR</h2>
        <p>Place the OMR sheet flat with good lighting. Tap “Capture & Grade”. Score appears at the bottom of the canvas and below.</p>

        <div className="grid">
          <div className="canvas-row">
            <div className="canvas-wrap">
              <video ref={videoRef} playsInline muted style={{width:'100%'}} />
            </div>
            <div className="card">
              <div className="kv">
                <div className="k">Answer Key</div>
                <div>
                  <input
                    value={answerKeyText}
                    onChange={e=>setAnswerKeyText(e.target.value)}
                    style={iStyle}
                    aria-label="Answer key list"
                  />
                  <small style={{color:'var(--muted)'}}>Comma-separated (0-4) for 5 questions, e.g. 1,2,0,2,4</small>
                </div>
                <div className="k">Questions</div><div>5</div>
                <div className="k">Choices</div><div>5</div>
              </div>

              <button className="btn primary" onClick={captureAndGrade} disabled={!ready || busy} style={{marginTop:12}}>
                {busy ? 'Processing…' : 'Capture & Grade'}
              </button>

              <div style={{marginTop:12}}><ScoreBar score={score} /></div>
              <div style={{marginTop:8}}>Picked: <b>[{answers.join(', ')}]</b></div>
            </div>
          </div>

          <div className="canvas-row">
            <canvas ref={canvasRef} style={{width:'100%'}} />
            <div className="card">
              <p><b>Tip:</b> Move closer so the sheet is the largest rectangle. Avoid shadows and skew.</p>
            </div>
          </div>
        </div>

        <ResultsTable picked={answers} answerKey={answerKeyText.split(',').map(n=>parseInt(n||0,10))} />
      </div>
    </main>
  )
}

const iStyle = { padding:10, borderRadius:10, border:'1px solid var(--border)', background:'#0b1020', color:'var(--text)', width:'100%' }
