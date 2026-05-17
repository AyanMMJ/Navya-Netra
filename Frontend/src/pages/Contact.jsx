export default function Contact() {
  const onSubmit = (e) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const name = fd.get('name')
    alert(`Thanks, ${name}! We'll get back to you.`)
    e.currentTarget.reset()
  }

  return (
    <main className="container">
      <div className="card">
        <h2>Contact Us</h2>
        <p>Questions or customizations? Send us a note.</p>
        <form onSubmit={onSubmit}>
          <div className="grid">
            <input name="name" placeholder="Your Name" required style={iStyle} />
            <input name="email" placeholder="Email" type="email" required style={iStyle} />
            <textarea name="message" rows="4" placeholder="Message" required style={iStyle}></textarea>
          </div>
          <button className="btn primary" style={{marginTop:12}}>Send</button>
        </form>
      </div>
    </main>
  )
}
const iStyle = { padding:12, borderRadius:12, border:'1px solid var(--border)', background:'#0b1020', color:'var(--text)' }
