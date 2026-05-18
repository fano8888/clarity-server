# Clarity Server

FFmpeg-powered video lag repair for Fano AI.  
Uses `mpdecimate` + `minterpolate MCI` — professional motion-compensated frame interpolation.

## Setup

```bash
cd clarity-server
npm install
node server.js
```

Server runs on http://localhost:3333

## API

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/fix` | Upload video (field: `video`), returns `{ jobId }` |
| GET | `/job/:id` | Poll status: `queued → processing → done/error` |
| GET | `/download/:id` | Download fixed MP4 |
| GET | `/health` | Health check |

## Query params for /fix

- `?mode=interpolate` (default) — removes lag + synthesises smooth frames via optical flow  
- `?mode=dedrop` — removes frozen frames only, no interpolation  
- `?fps=30` — output FPS (default: same as source)

## Environment variables

Copy `.env.example` to `.env`:

```
PORT=3333
ALLOWED_ORIGIN=https://your-domain.com
UPLOAD_DIR=/tmp/clarity-uploads
OUTPUT_DIR=/tmp/clarity-outputs
```

## Deployment options

### Railway (easiest, free tier available)
1. Push to GitHub
2. Connect repo on railway.app
3. Set env vars in dashboard
4. Done — Railway auto-detects Node.js

### Render
1. New Web Service → connect repo
2. Build: `npm install`  Start: `node server.js`
3. Set env vars

### VPS (DigitalOcean, Linode, etc.)
```bash
npm install -g pm2
pm2 start server.js --name clarity
pm2 save
```

### Docker
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3333
CMD ["node", "server.js"]
```

## Quality

FFmpeg `minterpolate` with `mi_mode=mci:mc_mode=aobmc:me_mode=bidir` is the same  
algorithm used in professional broadcast tools. Quality ceiling:

| Content | Result |
|---------|--------|
| Podcast / talking head | ★★★★★ |
| Screen recording | ★★★★★ |
| Slow movement | ★★★★★ |
| Fast movement | ★★★★☆ |
