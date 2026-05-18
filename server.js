const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const { v4: uuid } = require('uuid');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const path       = require('path');
const fs         = require('fs');
const os         = require('os');

// Explicitly set both ffmpeg and ffprobe paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

console.log('ffmpeg path:', ffmpegPath);
console.log('ffprobe path:', ffprobePath);

const app  = express();
const PORT = process.env.PORT || 3333;
const UPLOAD_DIR = path.join(os.tmpdir(), 'clarity-uploads');
const OUTPUT_DIR = path.join(os.tmpdir(), 'clarity-outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)||'.webm'}`),
});
const upload = multer({ storage, limits: { fileSize: 4*1024*1024*1024 } });

const jobs = new Map();
function pub(j){ return { id:j.id, status:j.status, progress:j.progress, message:j.message, downloadUrl:j.status==='done'?`/download/${j.id}`:null }; }

app.post('/fix', upload.single('video'), (req, res) => {
  if(!req.file) return res.status(400).json({ error:'No video received' });
  const id  = uuid();
  const fps = Math.min(parseInt(req.query.fps||'0')||0, 60);
  const job = {
    id, status:'queued', progress:0, message:'Queued',
    inputFile: req.file.path,
    outputFile: path.join(OUTPUT_DIR, `${id}_fixed.mp4`),
    createdAt: Date.now()
  };
  jobs.set(id, job);
  res.json({ jobId:id, pollUrl:`/job/${id}` });
  processVideo(job, fps);
});

async function processVideo(job, targetFps) {
  job.status='processing'; job.progress=2; job.message='Probing video…';
  try {
    const probe = await new Promise((resolve, reject) =>
      ffmpeg.ffprobe(job.inputFile, (err, d) => err ? reject(err) : resolve(d))
    );

    const vs     = probe.streams.find(s => s.codec_type === 'video');
    const srcFps = eval(vs?.r_frame_rate || '30/1');
    const outFps = targetFps || Math.min(Math.round(srcFps), 60);
    const dur    = parseFloat(probe.format.duration || '0');

    job.message  = `${Math.round(srcFps)}fps · ${dur.toFixed(1)}s → ${outFps}fps`;
    job.progress = 6;

    await new Promise((resolve, reject) => {
      ffmpeg(job.inputFile)
        .outputOptions([
          '-vf', `mpdecimate=max=0:hi=768:lo=320:frac=0.33,setpts=N/FRAME_RATE/TB,minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
          '-c:v',      'libx264',
          '-preset',   'fast',
          '-crf',      '18',
          '-c:a',      'aac',
          '-b:a',      '192k',
          '-movflags', '+faststart',
          '-pix_fmt',  'yuv420p',
        ])
        .output(job.outputFile)
        .on('progress', p => {
          job.progress = Math.min(96, Math.round(6 + (p.percent||0) * 0.9));
          job.message  = `${job.progress}% · ${p.timemark||''}`;
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const size = fs.statSync(job.outputFile).size;
    if(size < 1000) throw new Error('Output file empty');
    job.status='done'; job.progress=100;
    job.message=`Done · ${(size/1024/1024).toFixed(1)}MB`;

  } catch(err) {
    console.error(`[${job.id}]`, err.message);
    job.status='error'; job.message=err.message;
  } finally {
    try{ fs.unlinkSync(job.inputFile); }catch(e){}
  }
}

app.get('/job/:id',      (req,res) => { const j=jobs.get(req.params.id); if(!j) return res.status(404).json({error:'Not found'}); res.json(pub(j)); });
app.get('/download/:id', (req,res) => {
  const j=jobs.get(req.params.id);
  if(!j||j.status!=='done') return res.status(404).json({error:'Not ready'});
  if(!fs.existsSync(j.outputFile)) return res.status(410).json({error:'Expired'});
  const size=fs.statSync(j.outputFile).size;
  res.setHeader('Content-Type','video/mp4');
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Disposition','attachment; filename="clarity_fixed.mp4"');
  res.setHeader('Accept-Ranges','bytes');
  fs.createReadStream(j.outputFile).pipe(res);
});
app.get('/health', (req,res) => res.json({ ok:true, jobs:jobs.size, ffmpeg:ffmpegPath, ffprobe:ffprobePath }));

// Cleanup jobs older than 1 hour
setInterval(()=>{ const cut=Date.now()-3600000; for(const[id,j]of jobs){ if(j.createdAt<cut){ try{fs.unlinkSync(j.outputFile);}catch(e){} jobs.delete(id); } } }, 900000);

app.listen(PORT, ()=> console.log(`✓ Clarity Server on port ${PORT}`));
