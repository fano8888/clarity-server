const express     = require('express');
const multer      = require('multer');
const cors        = require('cors');
const { v4: uuid } = require('uuid');
const ffmpeg      = require('fluent-ffmpeg');
const ffmpegPath  = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const path        = require('path');
const fs          = require('fs');
const os          = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

console.log('ffmpeg:', ffmpegPath);
console.log('ffprobe:', ffprobePath);

const app  = express();
const PORT = process.env.PORT || 3333;
const UPLOAD_DIR = path.join(os.tmpdir(), 'clarity-uploads');
const OUTPUT_DIR = path.join(os.tmpdir(), 'clarity-outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)||'.mp4'}`),
});
const upload = multer({ storage, limits: { fileSize: 8*1024*1024*1024 } }); // 8GB

const jobs = new Map();
function pub(j){
  return {
    id: j.id, status: j.status, progress: j.progress,
    message: j.message,
    downloadUrl: j.status==='done' ? `/download/${j.id}` : null,
  };
}

// ── POST /fix ─────────────────────────────────────
// Query params:
//   ?upscale=4k       — upscale to 3840×2160
//   ?upscale=2k       — upscale to 2560×1440
//   ?upscale=1080     — upscale to 1920×1080 (default if source < 1080p)
//   ?upscale=source   — keep original resolution (default)
//   ?fps=30           — output FPS
//   ?sharpen=1        — apply unsharp mask after upscale (default on)
app.post('/fix', upload.single('video'), (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'No video received' });

  const id      = uuid();
  const upscale = req.query.upscale || 'source';
  const fps     = Math.min(parseInt(req.query.fps||'0')||0, 60);
  const sharpen = req.query.sharpen !== '0'; // default true

  const job = {
    id, status: 'queued', progress: 0, message: 'Queued',
    inputFile:  req.file.path,
    outputFile: path.join(OUTPUT_DIR, `${id}_fixed.mp4`),
    createdAt:  Date.now(),
  };
  jobs.set(id, job);
  res.json({ jobId: id, pollUrl: `/job/${id}` });
  processVideo(job, { upscale, fps, sharpen });
});

async function processVideo(job, opts) {
  job.status='processing'; job.progress=2; job.message='Probing video…';
  try {
    // ── Probe source ──────────────────────────────
    const probe = await new Promise((resolve, reject) =>
      ffmpeg.ffprobe(job.inputFile, (err, d) => err ? reject(err) : resolve(d))
    );
    const vs      = probe.streams.find(s => s.codec_type === 'video');
    const as      = probe.streams.find(s => s.codec_type === 'audio');
    const srcFps  = eval(vs?.r_frame_rate || '30/1');
    const outFps  = opts.fps || Math.min(Math.round(srcFps), 60);
    const dur     = parseFloat(probe.format.duration || '0');
    const srcW    = vs?.width  || 1280;
    const srcH    = vs?.height || 720;
    const hasAudio = !!as;

    job.message  = `${srcW}×${srcH} · ${Math.round(srcFps)}fps · ${dur.toFixed(1)}s · audio:${hasAudio}`;
    job.progress = 5;

    // ── Determine target resolution ───────────────
    let scaleW, scaleH;
    switch(opts.upscale){
      case '4k':    scaleW=3840; scaleH=2160; break;
      case '2k':    scaleW=2560; scaleH=1440; break;
      case '1080':  scaleW=1920; scaleH=1080; break;
      default:      scaleW=srcW; scaleH=srcH; break; // source resolution
    }
    // Never downscale — only upscale or keep
    if(scaleW < srcW) { scaleW=srcW; scaleH=srcH; }

    job.message = `${srcW}×${srcH} → ${scaleW}×${scaleH} · fixing lag…`;
    job.progress = 8;

    // ── Build video filter chain ──────────────────
    // 1. mpdecimate   — remove frozen/duplicate lag frames
    // 2. setpts       — re-time remaining frames (fixes audio sync drift)
    // 3. minterpolate — synthesise smooth frames via motion compensation
    // 4. scale        — upscale using lanczos (sharpest upscale algorithm)
    // 5. unsharp      — sharpen after upscale to restore crispness
    // 6. format       — ensure yuv420p for max compatibility
    const filters = [
      `mpdecimate=max=0:hi=768:lo=320:frac=0.33`,
      `setpts=N/FRAME_RATE/TB`,
      `minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
    ];

    if(scaleW !== srcW || scaleH !== srcH){
      // scale2ref keeps aspect ratio, pads to exact target with black bars if needed
      filters.push(`scale=${scaleW}:${scaleH}:flags=lanczos:force_original_aspect_ratio=decrease`);
      filters.push(`pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }

    if(opts.sharpen){
      // unsharp mask: luma 5×5 1.0 strength, chroma 3×3 0.5
      filters.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1.0:chroma_msize_x=3:chroma_msize_y=3:chroma_amount=0.5`);
    }

    filters.push(`format=yuv420p`);
    const vf = filters.join(',');

    // ── Audio filter chain ────────────────────────
    // aresample: re-sync audio to video timeline after frame removal
    // asetpts:   reset audio timestamps to match new video timeline
    // loudnorm:  normalise loudness to -14 LUFS (broadcast standard)
    const af = hasAudio
      ? `aresample=async=1000:first_pts=0,asetpts=N/SR/TB,loudnorm=I=-14:TP=-1:LRA=11`
      : null;

    job.progress = 10;

    // ── Run FFmpeg ────────────────────────────────
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(job.inputFile);

      const outputOpts = [
        '-vf',       vf,
        '-c:v',      'libx264',
        '-preset',   'slow',       // slower = better quality at same file size
        '-crf',      '16',         // visually lossless (16 = excellent for upscaled)
        '-movflags', '+faststart', // web optimised — plays before fully downloaded
        '-pix_fmt',  'yuv420p',
      ];

      if(hasAudio && af){
        outputOpts.push('-af',  af);
        outputOpts.push('-c:a', 'aac');
        outputOpts.push('-b:a', '320k');  // high quality audio
        outputOpts.push('-ar',  '48000'); // 48kHz — broadcast standard
        outputOpts.push('-async', '1');   // final audio sync pass
      } else if(!hasAudio){
        outputOpts.push('-an'); // no audio track
      }

      cmd
        .outputOptions(outputOpts)
        .output(job.outputFile)
        .on('progress', p => {
          job.progress = Math.min(96, Math.round(10 + (p.percent||0) * 0.86));
          job.message  = `${job.progress}% · ${p.timemark||''} · ${scaleW}×${scaleH}`;
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const size = fs.statSync(job.outputFile).size;
    if(size < 1000) throw new Error('Output file empty');

    job.status   = 'done';
    job.progress = 100;
    job.message  = `Done · ${(size/1024/1024).toFixed(1)}MB · ${scaleW}×${scaleH}`;
    console.log(`[${job.id}] Complete:`, job.message);

  } catch(err) {
    console.error(`[${job.id}] Error:`, err.message);
    job.status  = 'error';
    job.message = err.message;
  } finally {
    try{ fs.unlinkSync(job.inputFile); }catch(e){}
  }
}

// ── Routes ────────────────────────────────────────
app.get('/job/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if(!j) return res.status(404).json({ error: 'Not found' });
  res.json(pub(j));
});

app.get('/download/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if(!j || j.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  if(!fs.existsSync(j.outputFile)) return res.status(410).json({ error: 'Expired' });
  const size = fs.statSync(j.outputFile).size;
  res.setHeader('Content-Type',        'video/mp4');
  res.setHeader('Content-Length',      size);
  res.setHeader('Content-Disposition', 'attachment; filename="clarity_fixed.mp4"');
  res.setHeader('Accept-Ranges',       'bytes');
  fs.createReadStream(j.outputFile).pipe(res);
});

app.get('/health', (req, res) => res.json({
  ok: true, jobs: jobs.size,
  ffmpeg: !!ffmpegPath, ffprobe: !!ffprobePath,
}));

// Cleanup jobs older than 2 hours
setInterval(() => {
  const cut = Date.now() - 2*60*60*1000;
  for(const [id, j] of jobs){
    if(j.createdAt < cut){
      try{ if(j.outputFile) fs.unlinkSync(j.outputFile); }catch(e){}
      jobs.delete(id);
    }
  }
}, 30*60*1000);

app.listen(PORT, () => console.log(`✓ Clarity Server on port ${PORT}`));
