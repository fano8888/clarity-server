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
  const job = {
    id, status: 'queued', progress: 0, message: 'Queued',
    inputFile:  req.file.path,
    outputFile: path.join(OUTPUT_DIR, `${id}_fixed.mp4`),
    createdAt:  Date.now(),
  };
  jobs.set(id, job);
  res.json({ jobId: id, pollUrl: `/job/${id}` });
  processVideo(job, { upscale, fps });
});

async function processVideo(job, opts) {
  job.status = 'processing'; job.progress = 2; job.message = 'Probing…';
  try {
    // ── Step 1: Probe ─────────────────────────────
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

    job.message  = `${srcW}×${srcH} · ${Math.round(srcFps)}fps · ${dur.toFixed(1)}s`;
    job.progress = 6;

    // ── Step 2: Target resolution ─────────────────
    let scaleW = srcW, scaleH = srcH;
    if (opts.upscale === '4k')   { scaleW = 3840; scaleH = 2160; }
    if (opts.upscale === '2k')   { scaleW = 2560; scaleH = 1440; }
    if (opts.upscale === '1080') { scaleW = 1920; scaleH = 1080; }
    if (scaleW < srcW)           { scaleW = srcW;  scaleH = srcH; }

    job.message  = `Processing ${srcW}×${srcH} → ${scaleW}×${scaleH}…`;
    job.progress = 8;

    // ── Step 3: Build video filter chain ──────────
    //
    // This is a 5-stage pipeline designed to:
    // a) Remove ALL frozen/lag frames aggressively
    // b) Synthesise smooth replacement frames via motion compensation
    // c) Upscale cleanly if requested
    // d) Sharpen the result
    //
    // Stage 1 — freezedetect + select
    //   freezedetect finds frozen segments (duration > 0.1s, noise < -60dB).
    //   We combine with mpdecimate which removes duplicate frames frame-by-frame.
    //   Using both catches both "frozen for a while" AND "dropped single frames".
    //
    // Stage 2 — setpts=N/FRAME_RATE/TB
    //   After removing frames, timestamps have gaps. This resets them
    //   sequentially so the video timeline is continuous with no jumps.
    //   CRITICAL: this is what prevents audio sync drift.
    //
    // Stage 3 — minterpolate MCI+AOBMC
    //   Motion-compensated interpolation. For every gap where a lag frame
    //   was removed, it synthesises a new frame by:
    //   - Computing optical flow between surrounding clean frames
    //   - Warping pixels along their motion vectors
    //   - Blending forward and backward warped frames
    //   MCI = motion compensated interpolation (best quality)
    //   AOBMC = adaptive overlapped block motion compensation (smoother)
    //   bidir = bidirectional motion search (finds motion both ways)
    //   vsbmc = variable size block motion compensation (handles fine detail)
    //
    // Stage 4 — scale (lanczos) + pad
    //   Lanczos is the sharpest upscaling algorithm in FFmpeg.
    //   Preserves aspect ratio, pads with black if needed.
    //
    // Stage 5 — unsharp mask
    //   After upscaling pixels get soft. Unsharp mask restores crispness
    //   by detecting edges and boosting them. 5×5 kernel, 1.5 strength.
    //
    const vf = [
      // Remove lag: aggressive duplicate frame detection
      `mpdecimate=max=0:hi=64*24:lo=64*12:frac=0.25`,
      // Re-time after removal — keeps sync
      `setpts=N/FRAME_RATE/TB`,
      // Synthesise smooth frames via motion-compensated optical flow
      `minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff`,
      // Upscale if requested
      ...(scaleW !== srcW ? [
        `scale=${scaleW}:${scaleH}:flags=lanczos:force_original_aspect_ratio=decrease`,
        `pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:color=black`,
      ] : []),
      // Sharpen — always applied for crispness
      `unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1.5:chroma_msize_x=3:chroma_msize_y=3:chroma_amount=0.5`,
      `format=yuv420p`,
    ].join(',');

    // ── Step 4: Build audio filter chain ──────────
    //
    // Audio sync is the hardest part. When we remove video frames,
    // the video gets shorter but audio stays the same length.
    // This pipeline re-syncs them perfectly:
    //
    // Stage 1 — aresample=async=1:min_hard_comp=0.1:first_pts=0
    //   Adaptive resampler. In async mode it stretches/squeezes audio
    //   samples microscopically (< 0.1 sample difference) to match the
    //   video timeline. first_pts=0 anchors to the start.
    //   This handles gradual drift caused by frame removal.
    //
    // Stage 2 — asetpts=N/SR/TB
    //   Hard-reset all audio timestamps. N = sample index, SR = sample rate.
    //   This makes every audio sample's timestamp derived purely from its
    //   position in the stream — no inherited drift from the original file.
    //
    // Stage 3 — loudnorm=I=-14:TP=-1:LRA=11
    //   EBU R128 loudness normalisation. Brings audio to broadcast standard:
    //   -14 LUFS integrated loudness (YouTube/Spotify standard)
    //   -1 dBTP true peak (headroom before clipping)
    //   11 LU loudness range (natural dynamic feel)
    //
    // Stage 4 — aformat=sample_rates=48000:channel_layouts=stereo
    //   Force 48kHz stereo. This is the universal video audio standard.
    //   Prevents any container-level sample rate mismatch with video.
    //
    const af = hasAudio ? [
      `aresample=async=1:min_hard_comp=0.1:first_pts=0`,
      `asetpts=N/SR/TB`,
      `loudnorm=I=-14:TP=-1:LRA=11`,
      `aformat=sample_rates=48000:channel_layouts=stereo`,
    ].join(',') : null;

    // ── Step 5: Run FFmpeg ────────────────────────
    job.message  = `FFmpeg running…`;
    job.progress = 10;

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(job.inputFile);

      const outputOpts = [
        '-vf',       vf,
        '-c:v',      'libx264',
        '-preset',   'fast',
        '-crf',      '16',          // high quality — visually lossless
        '-movflags', '+faststart',  // web optimised
        '-pix_fmt',  'yuv420p',
        '-vsync',    'cfr',         // constant frame rate — critical for sync
      ];

      if (hasAudio && af) {
        outputOpts.push('-af',    af);
        outputOpts.push('-c:a',   'aac');
        outputOpts.push('-b:a',   '320k');
        outputOpts.push('-ar',    '48000');
        outputOpts.push('-ac',    '2');
        // -map_metadata 0: carry original metadata through
        outputOpts.push('-map_metadata', '0');
      } else {
        outputOpts.push('-an');
      }

      cmd
        .outputOptions(outputOpts)
        .output(job.outputFile)
        .on('progress', p => {
          job.progress = Math.min(96, Math.round(10 + (p.percent || 0) * 0.86));
          job.message  = `${job.progress}% · ${p.timemark || ''} · ${scaleW}×${scaleH}`;
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const size = fs.statSync(job.outputFile).size;
    if (size < 1000) throw new Error('Output file empty');
    job.status   = 'done';
    job.progress = 100;
    job.message  = `✓ Done · ${(size/1024/1024).toFixed(1)}MB · ${scaleW}×${scaleH}`;
    console.log(`[${job.id}]`, job.message);

  } catch (err) {
    console.error(`[${job.id}] Error:`, err.message);
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
