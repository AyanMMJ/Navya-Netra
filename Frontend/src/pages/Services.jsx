import { Link } from 'react-router-dom'

export default function Services() {
  return (
    <main className="container">
      <div className="grid cols-2">
        <div className="card">
          <h3>Live Camera OMR</h3>
          <p>Open the camera, capture the sheet, and grade instantly. Results show at the bottom overlay and as a table.</p>
          <Link to="/services/camera" className="btn primary">Open Live Camera</Link>
        </div>
        <div className="card">
          <h3>Upload Marksheet</h3>
          <p>Upload a clear photo/scan (JPG/PNG). We’ll detect bubbles and compute your score here.</p>
          <Link to="/services/upload" className="btn">Upload & Grade</Link>
        </div>
      </div>
    </main>
  )
}
