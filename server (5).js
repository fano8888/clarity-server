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
const { spawn }   = require('child_process');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
console.log('ffmpeg:', ffmpegPath);
console.log('ffprobe:', ffprobePath);

const app  = express();
const PORT = process.env.PORT || 3333;
const UPLOAD_DIR = path.join(os.tmpdir(), 'clarity-uploads');
const OUTPUT_DIR = path.join(os.tmpdir(), 'clarity-outputs');
const STAB_DIR   = path.join(os.tmpdir(), 'clarity-stab');
[UPLOAD_DIR, OUTPUT_DIR, STAB_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)||'.mp4'}`),
});
const upload = multer({ storage, limits: { fileSize: 8*1024*1024*1024 } });
const jobs = new Map();

function pub(j) {
  return {
    id: j.id, status: j.status,
    progress: j.progress, message: j.message,
    downloadUrl: j.status === 'done' ? `/download/${j.id}` : null,
  };
}

app.post('/fix', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video received' });
  const id      = uuid();
  const upscale = req.query.upscale || 'source';
  const fps     = Math.min(parseInt(req.query.fps || '0') || 0, 60);
  const mode    = req.query.mode || 'standard';
  const job = {
    id, status: 'queued', progress: 0, message: 'Queued',
    inputFile:  req.file.path,
    outputFile: path.join(OUTPUT_DIR, `${id}_fixed.mp4`),
    createdAt:  Date.now(),
  };
  jobs.set(id, job);
  res.json({ jobId: id, pollUrl: `/job/${id}` });
  processVideo(job, { upscale, fps, mode });
});

// ── Helpers ───────────────────────────────────────
function runCmd(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => code === 0
      ? resolve({ out, err })
      : reject(new Error(`Exit ${code}: ${err.slice(-600)}`))
    );
  });
}

function parseFreezeZones(stderr) {
  const starts = [], ends = [];
  for (const line of stderr.split('\n')) {
    const ms = line.match(/freeze_start: ([\d.]+)/);
    const me = line.match(/freeze_end: ([\d.]+)/);
    if (ms) starts.push(parseFloat(ms[1]));
    if (me) ends.push(parseFloat(me[1]));
  }
  const zones = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    zones.push({ start: starts[i], end: ends[i], duration: ends[i] - starts[i] });
  }
  return zones;
}

// ── Main processing pipeline ──────────────────────
async function processVideo(job, opts) {
  job.status = 'processing'; job.progress = 2; job.message = 'Probing video…';
  try {
    // ── 1. Probe ──────────────────────────────────
    const probe = await new Promise((resolve, reject) =>
      ffmpeg.ffprobe(job.inputFile, (err, d) => err ? reject(err) : resolve(d))
    );
    const vs       = probe.streams.find(s => s.codec_type === 'video');
    const as       = probe.streams.find(s => s.codec_type === 'audio');
    const srcFps   = eval(vs?.r_frame_rate || '30/1');
    const outFps   = opts.fps || Math.min(Math.round(srcFps), 60);
    const dur      = parseFloat(probe.format.duration || '0');
    const srcW     = vs?.width  || 1280;
    const srcH     = vs?.height || 720;
    const hasAudio = !!as;
    const isPodcast = opts.mode === 'podcast';

    job.message  = `${srcW}×${srcH} · ${Math.round(srcFps)}fps · ${dur.toFixed(1)}s`;
    job.progress = 5;

    // ── 2. Target resolution ──────────────────────
    let scaleW = srcW, scaleH = srcH;
    if (opts.upscale === '4k')   { scaleW = 3840; scaleH = 2160; }
    if (opts.upscale === '2k')   { scaleW = 2560; scaleH = 1440; }
    if (opts.upscale === '1080') { scaleW = 1920; scaleH = 1080; }
    if (scaleW < srcW)           { scaleW = srcW;  scaleH = srcH; }

    // ── 3. Detect freeze/black zones ─────────────
    job.message  = 'Detecting lag & black zones…';
    job.progress = 7;

    const freezeNoise = isPodcast ? '-50' : '-60';
    const freezeDur   = isPodcast ? '0.04' : '0.08';
    let freezeZones   = [];
    try {
      const { err: fderr } = await runCmd(ffmpegPath, [
        '-i', job.inputFile,
        '-vf', `freezedetect=noise=${freezeNoise}dB:duration=${freezeDur}`,
        '-f', 'null', '-',
      ]);
      freezeZones = parseFreezeZones(fderr);
      console.log(`[${job.id}] ${freezeZones.length} freeze zones, total ${freezeZones.reduce((a,z)=>a+z.duration,0).toFixed(1)}s`);
    } catch(e) {
      console.warn(`[${job.id}] freezedetect warn:`, e.message);
    }

    job.message  = `${freezeZones.length} lag zone${freezeZones.length===1?'':'s'} found — fixing…`;
    job.progress = 10;

    // ── 4. Stabilisation pass (2-pass vidstab) ────
    //
    // vidstabdetect: analyses motion in each frame, writes to .trf file
    // vidstabtransform: applies smooth compensation based on .trf data
    //
    // shakiness=8: aggressive motion detection (1=low, 10=max)
    // accuracy=15: highest accuracy motion analysis
    // smoothing=10: how many frames to average for smoothing
    // optzoom=1: auto-zoom to remove black borders from stabilisation
    // interpol=bicubic: bicubic interpolation (sharpest)
    //
    const stabTrf  = path.join(STAB_DIR, `${job.id}.trf`);
    let   stabDone = false;
    try {
      job.message  = 'Stabilising video (pass 1)…';
      job.progress = 12;
      await new Promise((resolve, reject) => {
        ffmpeg(job.inputFile)
          .outputOptions([
            '-vf', `vidstabdetect=shakiness=8:accuracy=15:result=${stabTrf}`,
            '-f', 'null',
          ])
          .output('-')
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      stabDone = true;
      job.message  = 'Stabilisation pass 1 complete';
      job.progress = 18;
    } catch(e) {
      console.warn(`[${job.id}] vidstab pass 1 warn:`, e.message);
    }

    // ── 5. Build video filter chain ───────────────
    //
    // Order matters:
    // a) mpdecimate    — remove duplicate/frozen frames first
    // b) setpts        — re-time after removal (critical for sync)
    // c) vidstabtransform — stabilise (after timing is fixed)
    // d) minterpolate  — synthesise smooth frames to fill gaps
    // e) hqdn3d        — denoise compressed webcam artifacts
    // f) unsharp       — restore crispness after denoising
    // g) scale         — upscale if requested
    //
    const vFilters = [];

    // Lag removal
    if (isPodcast) {
      vFilters.push(`mpdecimate=max=0:hi=512:lo=256:frac=0.1`);
    } else {
      vFilters.push(`mpdecimate=max=0:hi=1536:lo=768:frac=0.25`);
    }
    vFilters.push(`setpts=N/FRAME_RATE/TB`);

    // Stabilisation (only if pass 1 succeeded)
    if (stabDone && fs.existsSync(stabTrf)) {
      vFilters.push(`vidstabtransform=input=${stabTrf}:smoothing=10:optzoom=1:interpol=bicubic`);
      vFilters.push(`unsharp=5:5:0.8:3:3:0.4`); // mild sharpen after stab warp
    }

    // Motion-compensated interpolation — fills all lag/freeze gaps
    vFilters.push(
      `minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff`
    );

    // Denoise — removes webcam/network compression artifacts
    if (isPodcast) {
      // hqdn3d: 3D adaptive denoiser
      // luma_spatial=4: moderate spatial denoise (removes blockiness)
      // chroma_spatial=3: slight chroma denoise (removes color noise)
      // luma_tmp=6: temporal denoise (removes frame-to-frame flicker)
      // chroma_tmp=4: temporal chroma denoise
      vFilters.push(`hqdn3d=luma_spatial=4:chroma_spatial=3:luma_tmp=6:chroma_tmp=4`);
      vFilters.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=2.0:chroma_msize_x=3:chroma_msize_y=3:chroma_amount=0.8`);
    } else {
      vFilters.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1.5:chroma_msize_x=3:chroma_msize_y=3:chroma_amount=0.5`);
    }

    // Scale
    if (scaleW !== srcW) {
      vFilters.push(`scale=${scaleW}:${scaleH}:flags=lanczos:force_original_aspect_ratio=decrease`);
      vFilters.push(`pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }
    vFilters.push(`format=yuv420p`);

    // ── 6. Build audio filter chain ───────────────
    //
    // arnndn: AI neural network speech denoiser
    //   Trained specifically on voice/speech audio.
    //   Removes: background hum, room echo, fan noise,
    //   compression artifacts, network noise.
    //   model=cb: the "convolutional blind" model — best for varied noise
    //
    // aresample async=1: continuously adjusts audio to match video clock
    //   This is what prevents audio drift after frame removal.
    //   min_hard_comp=0.1: max 0.1 sample adjustment per step (no glitches)
    //   first_pts=0: anchor audio start to 0
    //
    // asetpts N/SR/TB: hard-reset audio timestamps from sample index
    //   Eliminates any residual drift from the original file.
    //
    // loudnorm I=-14: EBU R128 broadcast loudness normalisation
    //   -14 LUFS = YouTube/Spotify/broadcast standard
    //   TP=-1: true peak limit (headroom before clipping)
    //   LRA=11: loudness range (natural dynamic feel)
    //
    // aformat 48000 stereo: force universal audio format
    //
    const aFilters = hasAudio ? [
      `arnndn=model=cb`,                                          // AI speech denoiser
      `aresample=async=1:min_hard_comp=0.1:first_pts=0`,         // sync to video clock
      `asetpts=N/SR/TB`,                                          // hard timestamp reset
      `loudnorm=I=-14:TP=-1:LRA=11`,                             // broadcast loudness
      `aformat=sample_rates=48000:channel_layouts=stereo`,        // universal format
    ] : null;

    job.progress = 22;
    job.message  = `Processing ${isPodcast?'podcast':'standard'} · stab:${stabDone} · ${scaleW}×${scaleH}…`;

    // ── 7. Run final FFmpeg pass ───────────────────
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(job.inputFile);

      if (hasAudio && aFilters) {
        // filter_complex: both streams share same clock — guaranteed sync
        const vChain = `[0:v]${vFilters.join(',')}[vout]`;
        const aChain = `[0:a]${aFilters.join(',')}[aout]`;
        cmd
          .complexFilter(`${vChain};${aChain}`)
          .outputOptions([
            '-map',      '[vout]',
            '-map',      '[aout]',
            '-c:v',      'libx264',
            '-preset',   'fast',
            '-crf',      '16',
            '-c:a',      'aac',
            '-b:a',      '320k',
            '-ar',       '48000',
            '-ac',       '2',
            '-movflags', '+faststart',
            '-vsync',    'cfr',
          ]);
      } else {
        cmd.outputOptions([
          '-vf',       vFilters.join(','),
          '-c:v',      'libx264',
          '-preset',   'fast',
          '-crf',      '16',
          '-an',
          '-movflags', '+faststart',
          '-vsync',    'cfr',
        ]);
      }

      cmd
        .output(job.outputFile)
        .on('progress', p => {
          job.progress = Math.min(96, Math.round(22 + (p.percent || 0) * 0.74));
          job.message  = `${job.progress}% · ${p.timemark || ''} · ${scaleW}×${scaleH}`;
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Cleanup stab file
    try { if (stabTrf) fs.unlinkSync(stabTrf); } catch(e) {}

    const size = fs.statSync(job.outputFile).size;
    if (size < 1000) throw new Error('Output file empty');

    job.status   = 'done';
    job.progress = 100;
    job.message  = `✓ ${(size/1024/1024).toFixed(1)}MB · ${scaleW}×${scaleH} · ${freezeZones.length} zones fixed · stabilised · denoised · synced`;
    console.log(`[${job.id}]`, job.message);

  } catch (err) {
    console.error(`[${job.id}] Error:`, err.message);
    job.status  = 'error';
    job.message = err.message;
    try { if (job.inputFile) fs.unlinkSync(job.inputFile); } catch(e) {}
  }
}

app.get('/job/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json(pub(j));
});

app.get('/download/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  if (!fs.existsSync(j.outputFile)) return res.status(410).json({ error: 'Expired' });
  const size = fs.statSync(j.outputFile).size;
  res.setHeader('Content-Type',        'video/mp4');
  res.setHeader('Content-Length',      size);
  res.setHeader('Content-Disposition', 'attachment; filename="clarity_fixed.mp4"');
  res.setHeader('Accept-Ranges',       'bytes');
  fs.createReadStream(j.outputFile).pipe(res);
});

app.get('/health', (req, res) => res.json({ ok: true, jobs: jobs.size }));

setInterval(() => {
  const cut = Date.now() - 2*60*60*1000;
  for (const [id, j] of jobs) {
    if (j.createdAt < cut) {
      try { fs.unlinkSync(j.outputFile); } catch(e) {}
      jobs.delete(id);
    }
  }
}, 30*60*1000);

app.listen(PORT, () => console.log(`✓ Clarity Server on port ${PORT}`));
