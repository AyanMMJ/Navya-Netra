// Resize → gray → blur → Canny → find largest quad → perspective warp → threshold
// → split 5×5 → pick max fill each row → grade vs answerKey
export function runOMROnMat(cv, src, { questions=5, choices=5, answerKey=[1,2,0,2,4] }) {
  let img = new cv.Mat()
  cv.resize(src, img, new cv.Size(700,700))
  let imgGray = new cv.Mat(), imgBlur = new cv.Mat(), imgCanny = new cv.Mat()
  cv.cvtColor(img, imgGray, cv.COLOR_RGBA2GRAY, 0)
  cv.GaussianBlur(imgGray, imgBlur, new cv.Size(5,5), 1, 1, cv.BORDER_DEFAULT)
  cv.Canny(imgBlur, imgCanny, 10, 70)

  let contours = new cv.MatVector(), hierarchy = new cv.Mat()
  cv.findContours(imgCanny, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE)
  const rects = []
  for (let i=0;i<contours.size();i++){
    const cnt = contours.get(i), area = cv.contourArea(cnt)
    if (area > 1000){
      const peri = cv.arcLength(cnt, true)
      const approx = new cv.Mat()
      cv.approxPolyDP(cnt, approx, 0.02*peri, true)
      if (approx.rows === 4) rects.push({ cnt, area })
      approx.delete()
    }
  }
  rects.sort((a,b)=>b.area-a.area)
  if (!rects.length) { cleanup(); throw new Error('No rectangular sheet found') }

  const W=700,H=700
  const pts = reorder4(rects[0].cnt, cv)
  const srcTri = cv.matFromArray(4,1,cv.CV_32FC2, pts)
  const dstTri = cv.matFromArray(4,1,cv.CV_32FC2, [0,0, W,0, 0,H, W,H])
  const M = cv.getPerspectiveTransform(srcTri, dstTri)
  let warped = new cv.Mat()
  cv.warpPerspective(img, warped, M, new cv.Size(W,H))

  let warpGray = new cv.Mat(), thresh = new cv.Mat()
  cv.cvtColor(warped, warpGray, cv.COLOR_RGBA2GRAY, 0)
  cv.threshold(warpGray, thresh, 170, 255, cv.THRESH_BINARY_INV)

  const secW = Math.floor(W/choices), secH = Math.floor(H/questions)
  const picked = []
  for (let r=0;r<questions;r++){
    let best=-1,idx=0
    for (let c=0;c<choices;c++){
      const cell = thresh.roi(new cv.Rect(c*secW, r*secH, secW, secH))
      const val = cv.countNonZero(cell); cell.delete()
      if (val>best){best=val;idx=c}
    }
    picked.push(idx)
  }

  let correct = 0
  for (let i=0;i<questions;i++) if (picked[i]===answerKey[i]) correct++
  const scorePct = (correct/questions)*100

  function cleanup(){ [img,imgGray,imgBlur,imgCanny,contours,hierarchy,warped,warpGray,thresh,srcTri,dstTri,M].forEach(m=>{try{m.delete()}catch{}}) }
  cleanup()
  return { scorePct, picked }
}

function reorder4(cnt, cv){
  let peri = cv.arcLength(cnt, true), approx = new cv.Mat()
  cv.approxPolyDP(cnt, approx, 0.02*peri, true)
  let pts=[]
  for (let i=0;i<approx.rows;i++){ pts.push(approx.intPtr(i,0)[0], approx.intPtr(i,0)[1]) }
  const P=[]; for (let i=0;i<8;i+=2) P.push({x:pts[i],y:pts[i+1],s:pts[i]+pts[i+1],d:pts[i]-pts[i+1]})
  const tl=P.reduce((a,b)=>a.s<b.s?a:b), br=P.reduce((a,b)=>a.s>b.s?a:b)
  const tr=P.reduce((a,b)=>a.d>b.d?a:b), bl=P.reduce((a,b)=>a.d<b.d?a:b)
  return new Float32Array([tl.x,tl.y, tr.x,tr.y, bl.x,bl.y, br.x,br.y])
}

export function drawScoreOnCanvas(canvas, scorePct, picked, key){
  const ctx = canvas.getContext('2d')
  const W=canvas.width, H=canvas.height, choices=5, questions=5
  const secW=Math.floor(W/choices), secH=Math.floor(H/questions)

  ctx.save(); ctx.globalAlpha=.35; ctx.strokeStyle='#22c55e'
  for(let i=0;i<=choices;i++){ ctx.beginPath(); ctx.moveTo(i*secW,0); ctx.lineTo(i*secW,H); ctx.stroke() }
  for(let j=0;j<=questions;j++){ ctx.beginPath(); ctx.moveTo(0,j*secH); ctx.lineTo(W,j*secH); ctx.stroke() }
  ctx.restore()

  for(let r=0;r<questions;r++){
    const ok = key[r]===picked[r]
    const cx=(picked[r]*secW)+secW/2, cy=(r*secH)+secH/2
    ctx.beginPath(); ctx.fillStyle = ok?'rgba(34,197,94,.9)':'rgba(239,68,68,.9)'
    ctx.arc(cx,cy,Math.min(secW,secH)/6,0,Math.PI*2); ctx.fill()
  }

  ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillRect(0,H-54,W,54)
  ctx.fillStyle='#fff'; ctx.font='bold 20px system-ui'
  ctx.fillText(`Score: ${scorePct.toFixed(1)}%`,16,H-20)
  ctx.font='14px system-ui'; ctx.fillStyle='#cbd5e1'
  ctx.fillText(`Answers: [${picked.join(', ')}]`,160,H-20)
}
