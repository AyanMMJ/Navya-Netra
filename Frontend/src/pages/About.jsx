export default function About() {
  return (
    <main className="container">
      <div className="card">
        <h2>About Navya-Netra OMR</h2>
        <p>
          This web app ports your Python OMR logic to the browser using OpenCV.js.
          It detects the largest 4-point contour as the sheet, performs perspective
          correction, thresholds the image, splits a 5×5 grid (5 questions × 5 choices),
          counts filled pixels per cell, and grades against a configurable answer key.
        </p>
        <div className="kv" style={{marginTop:12}}>
          <div className="k">Tech</div><div>React 18, React Router, OpenCV.js</div>
          <div className="k">Privacy</div><div>Client-side only (no data leaves device)</div>
          <div className="k">Responsive</div><div>Mobile-first, looks great on phones & laptops</div>
        </div>
      </div>
    </main>
  )
}
