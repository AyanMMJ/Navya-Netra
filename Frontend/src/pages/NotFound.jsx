import { Link } from 'react-router-dom'
export default function NotFound() {
  return (
    <main className="container">
      <div className="card">
        <h2>404 — Page not found</h2>
        <p>The page you’re looking for doesn’t exist.</p>
        <Link to="/" className="btn">Go Home</Link>
      </div>
    </main>
  )
}
