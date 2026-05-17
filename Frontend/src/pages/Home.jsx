import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <main className="container">
      <section className="hero">
        <div className="card">
          <h1>Scan OMR Sheets — Right in Your Browser</h1>
          <p>Use your device camera or upload a marksheet image. We detect the sheet, warp, threshold, and grade answers instantly.</p>
          <div style={{display:'flex',gap:12,flexWrap:'wrap',marginTop:14}}>
            <Link to="/services/camera" className="btn primary">Live Camera OMR</Link>
            <Link to="/services/upload" className="btn">Upload Marksheet</Link>
            <Link to="/services" className="btn ok">Explore Services</Link>
          </div>
        </div>

        <div className="grid cols-2">
          <div className="card">
            <h3>Private & Fast</h3>
            <p>All processing runs locally via OpenCV.js — no uploads to a server.</p>
          </div>
          <div className="card">
            <h3>Accurate Scoring</h3>
            <p>Follows the same logic as your Python app: contours → perspective warp → threshold → 5×5 grid → max fill vote.</p>
          </div>
        </div>
      </section>
    </main>
  )
}
