import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home.jsx'
import About from './pages/About.jsx'
import Services from './pages/Services.jsx'
import CameraOMR from './pages/CameraOMR.jsx'
import UploadOMR from './pages/UploadOMR.jsx'
import Contact from './pages/Contact.jsx'
import NotFound from './pages/NotFound.jsx'

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home/>} />
      <Route path="/about" element={<About/>} />
      <Route path="/services" element={<Services/>} />
      <Route path="/services/camera" element={<CameraOMR/>} />
      <Route path="/services/upload" element={<UploadOMR/>} />
      <Route path="/contact" element={<Contact/>} />
      <Route path="*" element={<NotFound/>} />
    </Routes>
  )
}
