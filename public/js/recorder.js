/**
 * 语音录制。
 *
 * 编码格式按浏览器能力挑：Chrome/Firefox 走 Opus（webm/ogg），
 * Safari 只支持 mp4/aac，所以要按 isTypeSupported 逐个试，不能写死。
 * 录音期间用 AnalyserNode 取音量，画出实时电平条。
 */

const CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* 继续试下一个 */
    }
  }
  return ''; // 交给浏览器自己决定
}

export const isSupported = () =>
  typeof MediaRecorder !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  !!pickMimeType() !== null;

export class Recorder {
  /**
   * @param {{maxMs?: number, onLevel?: (v: number) => void, onTick?: (ms: number) => void, onAutoStop?: () => void}} [opts]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.startedAt = 0;
    this.pausedTotal = 0;
    this.pausedAt = 0;
    this.mimeType = '';
    this.audioCtx = null;
    this.analyser = null;
    this.raf = null;
    this.ticker = null;
    this.stopped = false;
  }

  async start() {
    if (this.mediaRecorder) return;

    if (!isSupported()) {
      throw new Error('这个浏览器不支持录音，可以改用「上传音频文件」');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.mimeType = pickMimeType();
    this.mediaRecorder = new MediaRecorder(
      this.stream,
      this.mimeType ? { mimeType: this.mimeType, audioBitsPerSecond: 64000 } : undefined,
    );
    this.mimeType = this.mediaRecorder.mimeType || this.mimeType || 'audio/webm';
    this.chunks = [];
    this.stopped = false;

    this.mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });

    this.mediaRecorder.start(250); // 每 250ms 给一片，长时间录音不会全压在内存里
    this.startedAt = Date.now();

    // 实时电平
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const buf = new Uint8Array(this.analyser.fftSize);
      const loop = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i += 1) {
          const v = Math.abs(buf[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        this.opts.onLevel?.(Math.min(1, peak * 1.8));
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      /* 没有电平条也能录 */
    }

    const maxMs = this.opts.maxMs || 300_000;
    this.ticker = setInterval(() => {
      const ms = this.elapsed();
      this.opts.onTick?.(ms);
      if (ms >= maxMs) {
        this.opts.onAutoStop?.();
      }
    }, 200);
  }

  elapsed() {
    if (!this.startedAt) return 0;
    const paused = this.pausedAt ? Date.now() - this.pausedAt : 0;
    return Date.now() - this.startedAt - this.pausedTotal - paused;
  }

  pause() {
    if (this.mediaRecorder?.state === 'recording') {
      this.mediaRecorder.pause();
      this.pausedAt = Date.now();
    }
  }

  resume() {
    if (this.mediaRecorder?.state === 'paused') {
      this.mediaRecorder.resume();
      if (this.pausedAt) this.pausedTotal += Date.now() - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  get paused() {
    return this.mediaRecorder?.state === 'paused';
  }

  /**
   * 停止并拿到录音。
   * @returns {Promise<{blob: Blob, durationMs: number, mimeType: string}>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || this.stopped) {
        reject(new Error('没有正在进行的录音'));
        return;
      }
      const durationMs = this.elapsed();
      this.stopped = true;

      this.mediaRecorder.addEventListener(
        'stop',
        () => {
          const type = (this.mimeType || 'audio/webm').split(';')[0];
          const blob = new Blob(this.chunks, { type });
          this.cleanup();
          if (blob.size === 0) reject(new Error('录音是空的，可能麦克风没被授权'));
          else resolve({ blob, durationMs, mimeType: type });
        },
        { once: true },
      );

      try {
        this.mediaRecorder.stop();
      } catch (err) {
        this.cleanup();
        reject(err);
      }
    });
  }

  /** 放弃录音，不产出文件 */
  cancel() {
    this.stopped = true;
    try {
      if (this.mediaRecorder?.state !== 'inactive') this.mediaRecorder.stop();
    } catch {
      /* 已经停了 */
    }
    this.cleanup();
  }

  cleanup() {
    clearInterval(this.ticker);
    this.ticker = null;
    cancelAnimationFrame(this.raf);
    this.raf = null;
    this.analyser = null;
    try {
      this.audioCtx?.close();
    } catch {
      /* 已关闭 */
    }
    this.audioCtx = null;
    // 必须关掉音轨，否则浏览器标签页上的「正在录音」指示灯不会灭
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
  }
}
