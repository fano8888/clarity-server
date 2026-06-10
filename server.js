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

const app  = express();
const PORT = process.env.PORT || 3333;
const UPLOAD_DIR = path.join(os.tmpdir(), 'clarity-uploads');
const OUTPUT_DIR = path.join(os.tmpdir(), 'clarity-outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(cors({ origin: '*' }));
app.use(express.json());

const FILTERS = { minterpolate:false, hqdn3d:false };
try {
  const out = execSync(`"${ffmpegPath}" -filters 2>&1`, { encoding:'utf8', timeout:8000 });
  Object.keys(FILTERS).forEach(f => { FILTERS[f] = out.includes(f); });
  console.log('Filters:', FILTERS);
} catch(e) {
  FILTERS.hqdn3d = true;
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)||'.mp4'}`),
});
const upload = multer({ storage, limits:{ fileSize:8*1024*1024*1024 } });
const jobs = new Map();

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
    const probe = await new Promise((res,rej) =>
      ffmpeg.ffprobe(job.inputFile, (err,d) => err ? rej(err) : res(d))
    );
    const vs       = probe.streams.find(s=>s.codec_type==='video');
    const as       = probe.streams.find(s=>s.codec_type==='audio');
    const srcFps   = eval(vs?.r_frame_rate||'30/1');
    const outFps   = opts.fps || Math.min(Math.round(srcFps), 60);
    const dur      = parseFloat(probe.format.duration||'0');
    const srcW     = vs?.width  || 1280;
    const srcH     = vs?.height || 720;
    const hasAudio = !!as;
    const isPodcast = opts.mode === 'podcast';
    const isTrim    = opts.mode === 'trim';
    const isAudio   = opts.mode === 'audio';

    // ── Trim ────────────────────────────────────────────────
    if(isTrim){
      const s = parseFloat(opts.start||'0');
      const e = parseFloat(opts.end||String(dur));
      job.message=`Trimming…`; job.progress=10;
      await new Promise((res,rej)=>{
        ffmpeg(job.inputFile).seekInput(s).duration(e-s)
          .outputOptions(['-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart'])
          .output(job.outputFile)
          .on('progress',p=>{job.progress=Math.min(96,Math.round(10+(p.percent||0)*0.86));})
          .on('end',res).on('error',rej).run();
      });
      const sz=fs.statSync(job.outputFile).size;
      if(sz<1000) throw new Error('Output empty');
      job.status='done';job.progress=100;job.message=`✓ Trimmed · ${(sz/1024/1024).toFixed(1)}MB`;
      return;
    }

    // ── Audio only ───────────────────────────────────────────
    if(isAudio && hasAudio){
      job.message='Cleaning audio…'; job.progress=10;
      const af=[
        'highpass=f=80','lowpass=f=12000',
        'agate=threshold=0.02:ratio=10:attack=2:release=200',
        'equalizer=f=200:t=o:w=100:g=-3','equalizer=f=3000:t=o:w=500:g=2',
        'acompressor=threshold=-18dB:ratio=4:attack=5:release=100:makeup=3dB',
        'loudnorm=I=-14:TP=-1:LRA=11',
        'aformat=sample_rates=48000:channel_layouts=stereo',
      ].join(',');
      await new Promise((res,rej)=>{
        ffmpeg(job.inputFile)
          .outputOptions(['-c:v','copy','-af',af,'-c:a','aac','-b:a','320k','-movflags','+faststart'])
          .output(job.outputFile)
          .on('progress',p=>{job.progress=Math.min(96,Math.round(10+(p.percent||0)*0.86));})
          .on('end',res).on('error',rej).run();
      });
      const sz=fs.statSync(job.outputFile).size;
      if(sz<1000) throw new Error('Output empty');
      job.status='done';job.progress=100;job.message=`✓ Audio cleaned · ${(sz/1024/1024).toFixed(1)}MB`;
      return;
    }

    // ── Output resolution ────────────────────────────────────
    let scaleW=srcW, scaleH=srcH;
    if(opts.upscale==='4k')  { scaleW=3840; scaleH=2160; }
    if(opts.upscale==='2k')  { scaleW=2560; scaleH=1440; }
    if(opts.upscale==='1080'){ scaleW=1920; scaleH=1080; }
    if(scaleW<srcW)          { scaleW=srcW; scaleH=srcH; }
    const isUpscaling = scaleW > srcW;
    const isLowRes    = srcH < 720;

    job.message=`${srcW}×${srcH} → ${scaleW}×${scaleH}…`; job.progress=8;

    // ── Video filters ────────────────────────────────────────
    const vf = [];

    // Remove duplicate/frozen frames (fixes lag)
    vf.push(isPodcast
      ? `mpdecimate=max=0:hi=512:lo=256:frac=0.1`
      : `mpdecimate=max=0:hi=1536:lo=768:frac=0.25`
    );
    vf.push(`setpts=N/FRAME_RATE/TB`);

    // Frame rate
    if(FILTERS.minterpolate){
      vf.push(`minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff`);
    } else {
      vf.push(`fps=${outFps}`);
    }

    // Temporal denoise
    if(FILTERS.hqdn3d){
      if(isPodcast || isLowRes){
        vf.push(isLowRes ? `hqdn3d=6:4:8:6` : `hqdn3d=4:3:6:4`);
      }
    }

    // Upscale with Lanczos
    if(isUpscaling){
      vf.push(`scale=${scaleW}:${scaleH}:flags=lanczos:force_original_aspect_ratio=decrease`);
      vf.push(`pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2`);
    }

    // Sharpen
    const sl = isUpscaling ? 2.5 : (isPodcast ? 2.0 : 1.5);
    const sc = isUpscaling ? 0.8 : 0.5;
    vf.push(`unsharp=5:5:${sl}:3:3:${sc}`);
    if(isUpscaling) vf.push(`unsharp=3:3:0.8:0:0:0`);

    // Colour correction
    if(isPodcast){
      vf.push(`eq=contrast=1.05:brightness=0.01:saturation=1.08`);
    } else {
      vf.push(`eq=contrast=1.08:brightness=0.01:saturation=1.1`);
    }

    vf.push(`format=yuv420p`);

    // ── Audio filters ────────────────────────────────────────
    const af = [
      `highpass=f=80`,
      `lowpass=f=12000`,
      `agate=threshold=0.02:ratio=10:attack=2:release=200`,
      `equalizer=f=200:t=o:w=100:g=-3`,
      `equalizer=f=3000:t=o:w=500:g=2`,
      `equalizer=f=8000:t=o:w=2000:g=1`,
      `acompressor=threshold=-18dB:ratio=4:attack=5:release=100:makeup=3dB`,
      `aresample=async=1:min_hard_comp=0.1:first_pts=0`,
      `asetpts=N/SR/TB`,
      `loudnorm=I=-14:TP=-1:LRA=11`,
      `aformat=sample_rates=48000:channel_layouts=stereo`,
    ];

    job.progress=12; job.message=`Encoding ${scaleW}×${scaleH}…`;

    // ── Encode ───────────────────────────────────────────────
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(job.inputFile);
      if(hasAudio){
        cmd.complexFilter(`[0:v]${vf.join(',')}[vout];[0:a]${af.join(',')}[aout]`)
           .outputOptions([
             '-map','[vout]','-map','[aout]',
             '-c:v','libx264','-preset','fast','-crf','16',
             '-c:a','aac','-b:a','192k','-ar','48000','-ac','2',
             '-movflags','+faststart','-vsync','cfr',
           ]);
      } else {
        cmd.outputOptions([
          `-vf`,vf.join(','),
          '-c:v','libx264','-preset','fast','-crf','16','-an',
          '-movflags','+faststart','-vsync','cfr',
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
    job.message=`✓ ${(size/1024/1024).toFixed(1)}MB · ${scaleW}×${scaleH}`;
    console.log(`[${job.id}]`,job.message);

  } catch(err){
    console.error(`[${job.id}] Error:`,err.message);
    job.status='error'; job.message=err.message;
  } finally {
    try{ fs.unlinkSync(job.inputFile); }catch(e){}
  }
}

app.get('/job/:id',(req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j) return res.status(404).json({error:'Not found'});
  res.json(pub(j));
});

app.get('/download/:id',(req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j||j.status!=='done') return res.status(404).json({error:'Not ready'});
  if(!fs.existsSync(j.outputFile)) return res.status(410).json({error:'Expired'});
  const size=fs.statSync(j.outputFile).size;
  res.setHeader('Content-Type','video/mp4');
  res.setHeader('Content-Length',size);
  res.setHeader('Content-Disposition','attachment; filename="clarity_fixed.mp4"');
  fs.createReadStream(j.outputFile).pipe(res);
});

app.get('/health',(req,res)=>res.json({ok:true,jobs:jobs.size,filters:FILTERS}));

setInterval(()=>{
  const cut=Date.now()-2*60*60*1000;
  for(const [id,j] of jobs){
    if(j.createdAt<cut){
      try{fs.unlinkSync(j.outputFile);}catch(e){}
      jobs.delete(id);
    }
  }
},30*60*1000);

app.listen(PORT,()=>console.log(`✓ Clarity Server port ${PORT}`, FILTERS));
