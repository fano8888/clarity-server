const express      = require('express');
const multer       = require('multer');
const cors         = require('cors');
const { v4: uuid } = require('uuid');
const ffmpeg       = require('fluent-ffmpeg');
const ffmpegPath   = require('ffmpeg-static');
const ffprobePath  = require('ffprobe-static').path;
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const { execSync } = require('child_process');

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

// ── Check available filters at startup ──────────────────────
const FILTERS = { minterpolate:false, hqdn3d:false, arnndn:false, vidstab:false, pp:false };
try {
  const out = execSync(`"${ffmpegPath}" -filters 2>&1`, { encoding:'utf8', timeout:8000 });
  Object.keys(FILTERS).forEach(f => { FILTERS[f] = out.includes(' '+f+' ') || out.includes('\t'+f+'\t'); });
  console.log('Filters:', FILTERS);
} catch(e) {
  console.warn('Could not check filters');
  FILTERS.hqdn3d = true;
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)||'.mp4'}`),
});
const upload = multer({ storage, limits:{ fileSize:8*1024*1024*1024 } });
const jobs   = new Map();

function pub(j){
  return { id:j.id, status:j.status, progress:j.progress, message:j.message,
           downloadUrl: j.status==='done' ? `/download/${j.id}` : null };
}

app.post('/fix', upload.single('video'), (req, res) => {
  if(!req.file) return res.status(400).json({ error:'No video received' });
  const id  = uuid();
  const job = {
    id, status:'queued', progress:0, message:'Queued',
    inputFile:  req.file.path,
    outputFile: path.join(OUTPUT_DIR, `${id}_fixed.mp4`),
    createdAt:  Date.now(),
  };
  jobs.set(id, job);
  res.json({ jobId:id, pollUrl:`/job/${id}` });
  processVideo(job, {
    upscale: req.query.upscale || 'source',
    fps:     Math.min(parseInt(req.query.fps||'0')||0, 60),
    mode:    req.query.mode || 'standard',
    start:   req.query.start,
    end:     req.query.end,
  });
});

async function processVideo(job, opts){
  job.status='processing'; job.progress=2; job.message='Probing…';
  try{
    // ── Probe ─────────────────────────────────────────────────
    const probe = await new Promise((res,rej) =>
      ffmpeg.ffprobe(job.inputFile, (err,d) => err ? rej(err) : res(d))
    );
    const vs      = probe.streams.find(s=>s.codec_type==='video');
    const as      = probe.streams.find(s=>s.codec_type==='audio');
    const srcFps  = eval(vs?.r_frame_rate||'30/1');
    const outFps  = opts.fps || Math.min(Math.round(srcFps), 60);
    const dur     = parseFloat(probe.format.duration||'0');
    const srcW    = vs?.width  || 1280;
    const srcH    = vs?.height || 720;
    const hasAudio= !!as;
    const mode    = opts.mode;
    const isPodcast = mode==='podcast';
    const isAudio   = mode==='audio';
    const isTrim    = mode==='trim';
    const isMax     = mode==='max';

    // ── Trim mode ─────────────────────────────────────────────
    if(isTrim){
      const trimStart = parseFloat(opts.start||'0');
      const trimEnd   = parseFloat(opts.end||String(dur));
      job.message=`Trimming ${trimStart.toFixed(1)}s → ${trimEnd.toFixed(1)}s`;
      job.progress=10;
      await new Promise((res,rej)=>{
        ffmpeg(job.inputFile)
          .seekInput(trimStart).duration(trimEnd-trimStart)
          .outputOptions(['-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart'])
          .output(job.outputFile)
          .on('progress',p=>{job.progress=Math.min(96,Math.round(10+(p.percent||0)*0.86));job.message=`Trimming ${job.progress}%`;})
          .on('end',res).on('error',rej).run();
      });
      const sz=fs.statSync(job.outputFile).size;
      if(sz<1000) throw new Error('Output empty');
      job.status='done';job.progress=100;job.message=`✓ Trimmed · ${(sz/1024/1024).toFixed(1)}MB`;
      return;
    }

    // ── Audio-only mode ───────────────────────────────────────
    if(isAudio && hasAudio){
      job.message='Audio-only clean…'; job.progress=10;
      const aChain=[
        'highpass=f=80','lowpass=f=12000',
        'agate=threshold=0.02:ratio=10:attack=2:release=200',
        'equalizer=f=200:t=o:w=100:g=-3','equalizer=f=3000:t=o:w=500:g=2',
        'acompressor=threshold=-18dB:ratio=4:attack=5:release=100:makeup=3dB',
        'loudnorm=I=-14:TP=-1:LRA=11','aformat=sample_rates=48000:channel_layouts=stereo',
      ].join(',');
      await new Promise((res,rej)=>{
        ffmpeg(job.inputFile)
          .outputOptions(['-c:v','copy',`-af`,aChain,'-c:a','aac','-b:a','320k','-movflags','+faststart'])
          .output(job.outputFile)
          .on('progress',p=>{job.progress=Math.min(96,Math.round(10+(p.percent||0)*0.86));})
          .on('end',res).on('error',rej).run();
      });
      const sz=fs.statSync(job.outputFile).size;
      if(sz<1000) throw new Error('Output empty');
      job.status='done';job.progress=100;job.message=`✓ Audio cleaned · ${(sz/1024/1024).toFixed(1)}MB`;
      return;
    }

    job.message=`${srcW}×${srcH} · ${Math.round(srcFps)}fps`; job.progress=6;

    // ── Output resolution ─────────────────────────────────────
    let scaleW=srcW, scaleH=srcH;
    if(opts.upscale==='4k')  { scaleW=3840; scaleH=2160; }
    if(opts.upscale==='2k')  { scaleW=2560; scaleH=1440; }
    if(opts.upscale==='1080'){ scaleW=1920; scaleH=1080; }
    if(scaleW<srcW)          { scaleW=srcW; scaleH=srcH; }
    const isUpscaling = scaleW>srcW;

    job.message=`${srcW}×${srcH} → ${scaleW}×${scaleH}…`; job.progress=8;

    // ════════════════════════════════════════════════════════════
    // VIDEO FILTER CHAIN — Maximum Clarity Pipeline
    // ════════════════════════════════════════════════════════════
    const vf = [];

    // ── 1. Remove duplicate / frozen frames ─────────────────
    // mpdecimate finds frames that are too similar and removes them
    // This fixes the "lag" and "freeze" effect from bad recordings
    vf.push(isPodcast
      ? `mpdecimate=max=0:hi=512:lo=256:frac=0.1`
      : `mpdecimate=max=0:hi=1536:lo=768:frac=0.25`
    );
    // Reset timestamps after frame removal — prevents audio drift
    vf.push(`setpts=N/FRAME_RATE/TB`);

    // ── 2. Frame rate fix ────────────────────────────────────
    if(FILTERS.minterpolate){
      vf.push(`minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff`);
    } else {
      vf.push(`fps=${outFps}`);
    }

// ── 4. Temporal denoise ─────────────────────────────────
    // hqdn3d: removes noise across both space and time
    // For low-res (< 720p) use stronger settings — more to clean up
    if(FILTERS.hqdn3d){
      const isLowRes = srcH < 720;
      if(isPodcast || isMax){
        vf.push(isLowRes
          ? `hqdn3d=6:4:8:6`    // strong for low-res
          : `hqdn3d=4:3:6:4`    // standard
        );
      } else if(isLowRes){
        vf.push(`hqdn3d=3:2:4:3`);
      }
    }

    // ── 5. Upscale with best algorithm ──────────────────────
    // For upscaling: use Lanczos (best quality) with extra sharpening pass
    // For same-size: skip scaling
    if(isUpscaling){
      // Scale up with Lanczos — preserves edges best
      vf.push(`scale=${scaleW}:${scaleH}:flags=lanczos+accurate_rnd+full_chroma_int:force_original_aspect_ratio=decrease`);
      vf.push(`pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:black`);
    }

    // ── 6. Sharpening ───────────────────────────────────────
    // unsharp mask — the most important filter for perceived clarity
    // Luma (brightness) sharpening is the most visible
    // For low-res upscaled content, use more aggressive sharpening
    const sharpenLuma  = isUpscaling ? 2.5 : (isPodcast ? 2.0 : 1.5);
    const sharpenChroma= isUpscaling ? 0.8 : 0.5;
    vf.push(`unsharp=5:5:${sharpenLuma}:3:3:${sharpenChroma}`);

    // ── 7. Edge enhancement after upscaling ─────────────────
    // Second lighter sharpen pass for extra crispness on upscaled video
    if(isUpscaling){
      vf.push(`unsharp=3:3:0.8:0:0:0`);
    }

    // ── 8. Colour + contrast correction ─────────────────────
    // eq filter: subtle contrast + saturation boost makes image look
    // professional and "punchy" without looking processed
    // For podcast: warmer, more natural. For max: stronger boost.
    if(isPodcast){
      vf.push(`eq=contrast=1.05:brightness=0.01:saturation=1.08:gamma=1.0`);
    } else if(isMax){
      vf.push(`eq=contrast=1.12:brightness=0.02:saturation=1.15:gamma=0.95`);
    } else {
      vf.push(`eq=contrast=1.08:brightness=0.01:saturation=1.1`);
    }

    // ── 9. Final pixel format ────────────────────────────────
    vf.push(`format=yuv420p`);

    // ════════════════════════════════════════════════════════════
    // AUDIO FILTER CHAIN — Professional Podcast Audio
    // ════════════════════════════════════════════════════════════
    const af = [
      // Frequency cleanup
      `highpass=f=80`,            // remove sub-bass rumble / desk vibration
      `lowpass=f=12000`,          // remove high-frequency hiss / digital noise
      // Noise gate — silences background between words
      `agate=threshold=0.02:ratio=10:attack=2:release=200`,
      // Voice EQ — cut mud, boost presence, add air
      `equalizer=f=200:t=o:w=100:g=-3`,   // cut boxiness
      `equalizer=f=3000:t=o:w=500:g=2`,   // boost voice presence
      `equalizer=f=8000:t=o:w=2000:g=1`,  // add air/crispness
      // Dynamic range compression — consistent loudness
      `acompressor=threshold=-18dB:ratio=4:attack=5:release=100:makeup=3dB`,
      // Sync to video clock — prevents drift after frame removal
      `aresample=async=1:min_hard_comp=0.1:first_pts=0`,
      `asetpts=N/SR/TB`,
      // Broadcast loudness normalisation — YouTube/Spotify standard
      `loudnorm=I=-14:TP=-1:LRA=11`,
      `aformat=sample_rates=48000:channel_layouts=stereo`,
    ];

    job.progress=12; job.message=`Encoding ${scaleW}×${scaleH} · clarity max…`;

    // ── Encode ────────────────────────────────────────────────
    // CRF 16 = very high quality (lower = better, 18 is standard)
    // preset=slow = better compression at same quality vs fast
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(job.inputFile);
      if(hasAudio){
        const vChain=`[0:v]${vf.join(',')}[vout]`;
        const aChain=`[0:a]${af.join(',')}[aout]`;
        cmd.complexFilter(`${vChain};${aChain}`)
           .outputOptions([
             '-map','[vout]','-map','[aout]',
             '-c:v','libx264',
             '-preset','slow',    // better quality than fast
             '-crf','16',         // higher quality than 18
             '-c:a','aac','-b:a','192k','-ar','48000','-ac','2',
             '-movflags','+faststart','-vsync','cfr',
             '-x264-params','deblock=1:1:psy-rd=1.0:aq-strength=1.2', // extra x264 sharpness
           ]);
      } else {
        cmd.outputOptions([
          `-vf`,vf.join(','),
          '-c:v','libx264','-preset','slow','-crf','16','-an',
          '-movflags','+faststart','-vsync','cfr',
          '-x264-params','deblock=1:1:psy-rd=1.0:aq-strength=1.2',
        ]);
      }
      cmd.output(job.outputFile)
         .on('progress',p=>{
           job.progress=Math.min(96,Math.round(12+(p.percent||0)*0.84));
           job.message=`${job.progress}% · ${p.timemark||''} · ${scaleW}×${scaleH}`;
         })
         .on('end',resolve)
         .on('error',e=>{ console.error(`[${job.id}]`,e.message); reject(e); })
         .run();
    });

    const size=fs.statSync(job.outputFile).size;
    if(size<1000) throw new Error('Output file empty');
    job.status='done'; job.progress=100;
    job.message=`✓ ${(size/1024/1024).toFixed(1)}MB · ${scaleW}×${scaleH} · clarity max`;
    console.log(`[${job.id}]`,job.message);

  } catch(err){
    console.error(`[${job.id}] Error:`,err.message);
    job.status='error'; job.message=err.message;
  } finally {
    try{ fs.unlinkSync(job.inputFile); }catch(e){}
  }
}

app.get('/job/:id', (req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j) return res.status(404).json({error:'Not found'});
  res.json(pub(j));
});

app.get('/download/:id', (req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j||j.status!=='done') return res.status(404).json({error:'Not ready'});
  if(!fs.existsSync(j.outputFile)) return res.status(410).json({error:'Expired'});
  const size=fs.statSync(j.outputFile).size;
  res.setHeader('Content-Type','video/mp4');
  res.setHeader('Content-Length',size);
  res.setHeader('Content-Disposition','attachment; filename="clarity_fixed.mp4"');
  res.setHeader('Accept-Ranges','bytes');
  fs.createReadStream(j.outputFile).pipe(res);
});

app.get('/health',(req,res)=>res.json({ok:true,jobs:jobs.size,filters:FILTERS}));

// Cleanup jobs older than 2 hours
setInterval(()=>{
  const cut=Date.now()-2*60*60*1000;
  for(const [id,j] of jobs){
    if(j.createdAt<cut){
      try{fs.unlinkSync(j.outputFile);}catch(e){}
      jobs.delete(id);
    }
  }
},30*60*1000);

app.listen(PORT,()=>{
  console.log(`✓ Clarity Server port ${PORT}`);
  console.log(`  Filters:`,FILTERS);
});
