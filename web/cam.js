/* Game Day - the jumbotron's camera and microphone.

   The laptop sits beside the TV facing the couch, so its camera sees the
   room the way a stadium camera sees the stands. Three jobs:

   COUGAR CAM. Find the people (MediaPipe's object detector, people only,
   bundled in web/lib/mediapipe so it needs no CDN), pick one who has not
   been on recently, and zoom the picture in on them. The zoom is a crop of
   the camera picture drawn on a canvas - no camera moves - so it is
   grainier the further away they sit; a stadium screen is grainy too.

   NOISE. The microphone's loudness, against the room's own normal (the
   median of the last minute and a half): a jump well above it, held for
   half a second, is the room going off.

   REACTIONS. When the room goes off, keep the ten seconds before it and
   five after. A recording cannot be started in the past, so a fresh
   MediaRecorder starts every eight seconds and each lives 26; at any
   moment one of them started 8-16 seconds ago, and that is the one kept.
   Clips go into IndexedDB on this laptop and never leave it.

   Nothing here makes a sound. */

const MP = './lib/mediapipe/';

export function createCam(opts = {}){
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.autoplay = true;
  let stream = null, detector = null, detectBusy = false, lastDetect = 0;
  let people = [];                // [{x, y, w, h, s}] in 0..1 of the picture, newest detection
  let ac = null, an = null, buf = null;
  const levels = [];              // dB every 100 ms, the last 90 s
  let short = [], spikeRun = 0, lastSpike = -1e9, level = -90, base = -60;
  const recs = [];                // rotating recorders
  let claim = null;
  const listeners = {spike: [], clip: [], people: []};
  const on = (ev, fn) => (listeners[ev] = listeners[ev] || []).push(fn);
  const fire = (ev, x) => (listeners[ev] || []).forEach(f => { try { f(x); } catch(e){ console.error(e); } });
  const status = {camera: 'off', mic: 'off', detector: 'off', recording: 'off', error: ''};
  const timers = [];

  async function start(){
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {width: {ideal: 1920}, height: {ideal: 1080}, facingMode: 'user'},
        audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
    } catch(e){
      try { stream = await navigator.mediaDevices.getUserMedia({video: true, audio: true}); }
      catch(e2){ status.error = 'No camera: ' + (e2.message || e2.name); status.camera = 'off'; return status; }
    }
    video.srcObject = stream;
    try { await video.play(); } catch(e){}
    status.camera = 'on';
    startMic();
    startRecorders();
    loadDetector();
    return status;
  }

  /* ---------- people ---------- */
  async function loadDetector(){
    status.detector = 'loading';
    try {
      const {FilesetResolver, ObjectDetector} = await import(MP + 'vision_bundle.mjs');
      const files = await FilesetResolver.forVisionTasks(new URL(MP, location.href).href.replace(/\/$/, ''));
      detector = await ObjectDetector.createFromOptions(files, {
        baseOptions: {modelAssetPath: MP + 'efficientdet_lite0.tflite', delegate: opts.cpu ? 'CPU' : 'GPU'},
        runningMode: 'VIDEO', scoreThreshold: 0.3, maxResults: 10, categoryAllowlist: ['person']});
      status.detector = 'on';
    } catch(e){
      console.warn('detector', e);
      // a laptop whose GPU path fails can still do this on the CPU
      if(!opts.cpu){ opts.cpu = true; return loadDetector(); }
      status.detector = 'off'; status.error = 'People finder failed: ' + (e.message || e);
    }
  }
  function detect(){
    if(!detector || detectBusy || video.readyState < 2) return people;
    const t = performance.now();
    if(t - lastDetect < 600) return people;
    lastDetect = t;
    detectBusy = true;
    try {
      const r = detector.detectForVideo(video, t);
      const W = video.videoWidth, H = video.videoHeight;
      people = (r.detections || []).map(d => ({x: d.boundingBox.originX / W, y: d.boundingBox.originY / H,
        w: d.boundingBox.width / W, h: d.boundingBox.height / H, s: d.categories[0].score}))
        .filter(p => p.w > 0.03 && p.h > 0.06);
      fire('people', people);
    } catch(e){ console.warn(e); }
    detectBusy = false;
    return people;
  }
  timers.push(setInterval(detect, 700));

  /* Head and shoulders of a person box, as a 16:9 crop of the picture. */
  function frameOf(p){
    const W = video.videoWidth || 16, H = video.videoHeight || 9, ar = 16 / 9;
    let w = Math.max(p.w * 1.7, 0.16) * W;
    let h = w / ar;
    const cx = (p.x + p.w / 2) * W;
    const cy = p.y * H + h * 0.38;              // the head in the top third
    w = Math.min(w, W); h = Math.min(h, H);
    const x = Math.max(0, Math.min(W - w, cx - w / 2)), y = Math.max(0, Math.min(H - h, cy - h / 2));
    return {x, y, w, h};
  }

  /* ---------- noise ---------- */
  function startMic(){
    if(!stream.getAudioTracks().length) return;
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      an = ac.createAnalyser(); an.fftSize = 2048;
      buf = new Float32Array(an.fftSize);
      src.connect(an);                         // to the analyser only: never to the speakers
      status.mic = 'on';
      if(ac.state === 'suspended') ac.resume();
    } catch(e){ status.mic = 'off'; return; }
    timers.push(setInterval(listen, 100));
    timers.push(setInterval(() => {
      if(levels.length > 20){ const s = levels.slice().sort((a, b) => a - b); base = s[s.length >> 1]; }
    }, 1000));
  }
  function listen(){
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for(let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    level = 10 * Math.log10(sum / buf.length + 1e-10);
    levels.push(level); if(levels.length > 900) levels.shift();
    short.push(level); if(short.length > 6) short.shift();
    const loud = short.reduce((a, b) => a + b, 0) / short.length;
    const over = loud - base;
    if(over > (opts.spikeDb || 14) && loud > (opts.floorDb || -38)) spikeRun++; else spikeRun = 0;
    const t = performance.now();
    if(spikeRun >= 5 && t - lastSpike > 25000){
      lastSpike = t; spikeRun = 0;
      fire('spike', {t, over, loud});
      keep(t, loud);
    }
  }

  /* ---------- reactions ---------- */
  const MIME = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  function startRecorders(){
    if(!window.MediaRecorder || !MIME){ status.recording = 'unsupported'; return; }
    status.recording = 'on';
    const spawn = () => {
      if(!stream) return;
      let r;
      try { r = new MediaRecorder(stream, {mimeType: MIME, videoBitsPerSecond: 2500000}); }
      catch(e){ status.recording = 'failed'; return; }
      const it = {r, start: performance.now(), chunks: [], claimed: false};
      r.ondataavailable = e => { if(e.data && e.data.size) it.chunks.push(e.data); };
      r.onstop = () => {
        const i = recs.indexOf(it); if(i >= 0) recs.splice(i, 1);
        if(it.claimed && it.chunks.length) it.done(new Blob(it.chunks, {type: MIME.split(';')[0]}));
      };
      r.start(1000);
      recs.push(it);
    };
    spawn();
    timers.push(setInterval(() => {
      const t = performance.now();
      recs.forEach(it => { if(!it.claimed && t - it.start > 26000 && it.r.state !== 'inactive') it.r.stop(); });
      spawn();
    }, 8000));
  }
  function keep(t, loud){
    if(claim) return;
    // the youngest recorder that has at least 8 s before the shout
    const it = recs.filter(x => !x.claimed && x.start <= t - 8000).sort((a, b) => b.start - a.start)[0];
    if(!it) return;
    it.claimed = true;
    claim = it;
    it.done = blob => {
      claim = null;
      const clip = {id: 'c' + Math.round(Date.now()), real: Date.now(), pre: (t - it.start) / 1000, loud, blob, mime: blob.type,
        wall: opts.now ? opts.now() - (performance.now() - t) : Date.now()};
      saveClip(clip).then(() => fire('clip', clip));
    };
    setTimeout(() => { if(it.r.state !== 'inactive') it.r.stop(); }, 5000);
  }

  return {
    video, start, on, status, frameOf,
    people: () => people,
    level: () => ({level, base, over: level - base}),
    shout(){ const t = performance.now(); lastSpike = t; fire('spike', {t, over: 99, loud: level}); keep(t, level); },
    stop(){ timers.forEach(clearInterval); recs.forEach(x => { try { x.r.stop(); } catch(e){} }); if(stream) stream.getTracks().forEach(t => t.stop()); if(ac) ac.close(); },
  };
}

/* ---------- the clips, in IndexedDB ---------- */
function db(){
  return new Promise((ok, no) => {
    const r = indexedDB.open('gameday', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('clips', {keyPath: 'id'});
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
export async function saveClip(c){
  try {
    const d = await db();
    await new Promise((ok, no) => { const tx = d.transaction('clips', 'readwrite'); tx.objectStore('clips').put(c); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    // keep the 40 loudest
    const all = await listClips();
    if(all.length > 40){
      const drop = all.slice().sort((a, b) => a.loud - b.loud).slice(0, all.length - 40);
      const tx = d.transaction('clips', 'readwrite');
      drop.forEach(x => tx.objectStore('clips').delete(x.id));
    }
  } catch(e){ console.warn('clip not saved', e); }
}
export async function listClips(){
  try {
    const d = await db();
    return await new Promise((ok, no) => { const r = d.transaction('clips').objectStore('clips').getAll(); r.onsuccess = () => ok(r.result.sort((a, b) => a.real - b.real)); r.onerror = () => no(r.error); });
  } catch(e){ return []; }
}
export async function clearClips(){
  try { const d = await db(); d.transaction('clips', 'readwrite').objectStore('clips').clear(); } catch(e){}
}
