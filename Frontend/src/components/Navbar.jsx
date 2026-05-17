import { NavLink, Link } from 'react-router-dom'
import { useState } from 'react'

export default function Navbar() {
  const [open, setOpen] = useState(false)
  return (
    <header className="nav">
      <div className="container nav-inner">
        <Link to="/" className="brand">Navya-Netra <span>OMR</span></Link>

        <button className="hamb btn" onClick={()=>setOpen(v=>!v)} aria-label="Toggle menu">☰</button>

        <nav className={`menu ${open ? 'open' : ''}`} onClick={()=>setOpen(false)}>
          <NavLink to="/" end className={({isActive})=>isActive?'active':''}>Home</NavLink>
          <NavLink to="/about" className={({isActive})=>isActive?'active':''}>About</NavLink>
          <NavLink to="/services" className={({isActive})=>isActive?'active':''}>Services</NavLink>
          <NavLink to="/contact" className={({isActive})=>isActive?'active':''}>Contact</NavLink>
        </nav>
      </div>
    </header>
  )
}
