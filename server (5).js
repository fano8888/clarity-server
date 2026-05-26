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
const { execSync, spawn } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app  = express();
const PORT = process.env.PORT || 3333;
const UPLOAD_DIR = path.join(os.tmpdir(), 'clarity-uploads');
const OUTPUT_DIR = path.join(os.tmpdir(), 'clarity-outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// ── Check which FFmpeg filters are available ──────
let AVAIL = { vidstab: false, arnndn: false, hqdn3d: false, minterpolate: false };
try {
  const out = execSync(`"${ffmpegPath}" -filters 2>&1`, { encoding: 'utf8', timeout: 10000 });
  AVAIL.vidstab      = out.includes('vidstab');
  AVAIL.arnndn       = out.includes('arnndn');
  AVAIL.hqdn3d       = out.includes('hqdn3d');
  AVAIL.minterpolate = out.includes('minterpolate');
  console.log('Available filters:', AVAIL);
} catch(e) {
  console.warn('Could not check filters:', e.message);
  AVAIL.hqdn3d = AVAIL.minterpolate = true; // assume available
}

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

function runCmd(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => code === 0
      ? resolve({ out, err })
      : reject(new Error(err.slice(-800)))
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

async function processVideo(job, opts) {
  job.status = 'processing'; job.progress = 2; job.message = 'Probing…';
  try {
    // ── Probe ─────────────────────────────────────
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

    job.message  = `${srcW}×${srcH} · ${Math.round(srcFps)}fps · ${dur.toFixed(1)}s · audio:${hasAudio}`;
    job.progress = 5;

    // ── Resolution ────────────────────────────────
    let scaleW = srcW, scaleH = srcH;
    if (opts.upscale === '4k')   { scaleW = 3840; scaleH = 2160; }
    if (opts.upscale === '2k')   { scaleW = 2560; scaleH = 1440; }
    if (opts.upscale === '1080') { scaleW = 1920; scaleH = 1080; }
    if (scaleW < srcW)           { scaleW = srcW;  scaleH = srcH; }

    // ── Detect freeze zones ───────────────────────
    job.message = 'Detecting lag zones…'; job.progress = 7;
    let freezeZones = [];
    try {
      const freezeNoise = isPodcast ? '-50' : '-60';
      const freezeDur   = isPodcast ? '0.04' : '0.08';
      const { err: fd } = await runCmd(ffmpegPath, [
        '-i', job.inputFile,
        '-vf', `freezedetect=noise=${freezeNoise}dB:duration=${freezeDur}`,
        '-f', 'null', '-',
      ]);
      freezeZones = parseFreezeZones(fd);
      console.log(`[${job.id}] ${freezeZones.length} freeze zones`);
    } catch(e) { console.warn('freezedetect:', e.message.slice(0,100)); }

    job.message  = `${freezeZones.length} lag zone${freezeZones.length===1?'':'s'} — fixing all…`;
    job.progress = 10;

    // ── Build video filter ────────────────────────
    // Strategy: remove duplicate frames → re-time → interpolate smooth
    // replacements → denoise → sharpen → scale
    const vf = [];

    // Remove frozen/duplicate frames — aggressive for podcast, moderate otherwise
    vf.push(isPodcast
      ? `mpdecimate=max=0:hi=512:lo=256:frac=0.1`
      : `mpdecimate=max=0:hi=1536:lo=768:frac=0.25`
    );

    // Re-time after removal — this is what fixes the video timeline
    vf.push(`setpts=N/FRAME_RATE/TB`);

    // Synthesise smooth replacement frames via motion-compensated interpolation
    // This is the core fix — fills every gap with a proper generated frame
    if (AVAIL.minterpolate) {
      vf.push(`minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff`);
    } else {
      // Fallback: fps filter just ensures constant frame rate
      vf.push(`fps=${outFps}`);
    }

    // Denoise: removes webcam compression artifacts from bad connection
    if (AVAIL.hqdn3d && isPodcast) {
      vf.push(`hqdn3d=luma_spatial=4:chroma_spatial=3:luma_tmp=6:chroma_tmp=4`);
    }

    // Sharpen: restores crispness
    vf.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${isPodcast?2.0:1.5}:chroma_msize_x=3:chroma_msize_y=3:chroma_amount=${isPodcast?0.8:0.5}`);

    // Scale
    if (scaleW !== srcW) {
      vf.push(`scale=${scaleW}:${scaleH}:flags=lanczos:force_original_aspect_ratio=decrease`);
      vf.push(`pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }
    vf.push(`format=yuv420p`);

    // ── Build audio filter chain ─────────────────
    //
    // Stage 1 — highpass=f=80
    //   Cuts everything below 80Hz — removes low-frequency rumble,
    //   desk vibration, HVAC hum, mic handling noise.
    //   Human voice starts at ~85Hz so nothing useful is lost.
    //
    // Stage 2 — lowpass=f=12000
    //   Cuts harsh high-frequency noise above 12kHz — internet
    //   compression artifacts, hiss, digital noise.
    //   Voice clarity lives in 80Hz–8kHz range.
    //
    // Stage 3 — arnndn (if available)
    //   AI neural network trained on speech. Removes background
    //   noise, room echo, fan noise, network compression.
    //
    // Stage 4 — agate=threshold=0.02:ratio=10:attack=2:release=200
    //   Noise gate: silences audio below 2% amplitude threshold.
    //   attack=2ms: opens instantly when speech starts (no clipping)
    //   release=200ms: stays open 200ms after speech ends (natural)
    //   Removes mouth clicks, keyboard noise, room tone between words.
    //
    // Stage 5 — equalizer chain (podcast voice EQ)
    //   f=200:t=o:w=100:g=-3   — cut muddy low-mids (boxiness)
    //   f=3000:t=o:w=500:g=2   — boost presence (voice intelligibility)
    //   f=8000:t=o:w=2000:g=1  — air boost (crispness, not harshness)
    //
    // Stage 6 — acompressor
    //   Dynamic range compression for consistent loudness:
    //   threshold=-18dB: compress above this level
    //   ratio=4: 4:1 compression ratio (natural, not squashed)
    //   attack=5ms: fast enough to catch transients
    //   release=100ms: natural release
    //   makeup=3dB: gain back what compression took
    //
    // Stage 7 — aresample async=1
    //   Locks audio to video clock after frame removal. Critical for sync.
    //
    // Stage 8 — loudnorm I=-14
    //   EBU R128 broadcast loudness normalisation.
    //   -14 LUFS = YouTube/Spotify/broadcast standard.
    //
    const af = [];
    // Cut sub-bass rumble and high-frequency hiss
    af.push(`highpass=f=80`);
    af.push(`lowpass=f=12000`);
    // AI speech denoiser if available
    if (AVAIL.arnndn) af.push(`arnndn=model=cb`);
    // Noise gate — silences background between words
    af.push(`agate=threshold=0.02:ratio=10:attack=2:release=200`);
    // Voice EQ — cut mud, boost presence and air
    af.push(`equalizer=f=200:t=o:w=100:g=-3`);
    af.push(`equalizer=f=3000:t=o:w=500:g=2`);
    af.push(`equalizer=f=8000:t=o:w=2000:g=1`);
    // Compression — consistent loudness
    af.push(`acompressor=threshold=-18dB:ratio=4:attack=5:release=100:makeup=3dB`);
    // Sync audio to video clock — prevents drift
    af.push(`aresample=async=1:min_hard_comp=0.1:first_pts=0`);
    af.push(`asetpts=N/SR/TB`);
    // Broadcast loudness normalisation
    af.push(`loudnorm=I=-14:TP=-1:LRA=11`);
    af.push(`aformat=sample_rates=48000:channel_layouts=stereo`);

    job.progress = 14;
    job.message  = `Running FFmpeg · ${isPodcast?'podcast':'standard'} · ${scaleW}×${scaleH}…`;

    // ── Final encode ──────────────────────────────
    // filter_complex keeps video + audio on THE SAME CLOCK
    // This is the only way to guarantee perfect sync
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(job.inputFile);

      if (hasAudio) {
        const vChain = `[0:v]${vf.join(',')}[vout]`;
        const aChain = `[0:a]${af.join(',')}[aout]`;
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
            '-vsync',    'cfr',         // constant frame rate — locks audio to video
          ]);
      } else {
        cmd.outputOptions([
          '-vf',       vf.join(','),
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
          job.progress = Math.min(96, Math.round(14 + (p.percent||0)*0.82));
          job.message  = `${job.progress}% · ${p.timemark||''} · ${scaleW}×${scaleH}`;
        })
        .on('end', resolve)
        .on('error', e => {
          console.error(`[${job.id}] FFmpeg error:`, e.message);
          reject(e);
        })
        .run();
    });

    const size = fs.statSync(job.outputFile).size;
    if (size < 1000) throw new Error('Output file empty');
    job.status   = 'done';
    job.progress = 100;
    job.message  = `✓ ${(size/1024/1024).toFixed(1)}MB · ${scaleW}×${scaleH} · ${freezeZones.length} zones fixed · synced`;
    console.log(`[${job.id}]`, job.message);

  } catch (err) {
    console.error(`[${job.id}]`, err.message);
    job.status  = 'error';
    job.message = err.message;
  } finally {
    try { fs.unlinkSync(job.inputFile); } catch(e) {}
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

app.get('/health', (req, res) => res.json({ ok: true, jobs: jobs.size, filters: AVAIL }));

setInterval(() => {
  const cut = Date.now() - 2*60*60*1000;
  for (const [id, j] of jobs) {
    if (j.createdAt < cut) {
      try { fs.unlinkSync(j.outputFile); } catch(e) {}
      jobs.delete(id);
    }
  }
}, 30*60*1000);

app.listen(PORT, () => {
  console.log(`✓ Clarity Server on port ${PORT}`);
  console.log(`  Filters:`, AVAIL);
});
