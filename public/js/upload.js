/**
 * 分块上传。
 *
 * 设计目标就是「几个 G 的文件、网络不稳、中途还能刷新页面」：
 *  - 按服务端给的分块大小切片，每片单独 PUT，互不影响；
 *  - 并发上传 3 片，打满带宽又不至于把请求队列堵死；
 *  - 每片失败重试 3 次，指数退避；
 *  - 上传进度写进 localStorage，刷新页面后能接着传，不用从零开始；
 *  - 全程可取消，取消时通知服务端删掉临时分块。
 */

const STORAGE_KEY = 'vellum.pendingUploads';
const CONCURRENCY = 3;
const RETRIES = 3;

/* ------------------------------------------------------------------ */
/* 断点续传的本地记录                                                   */
/* ------------------------------------------------------------------ */

function readPending() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writePending(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式下写不进去，降级成「不记忆」而已 */
  }
}

/** 用文件名 + 大小 + 修改时间做指纹，同一个文件重传就能命中 */
function fingerprint(file) {
  return `${file.name}|${file.size}|${file.lastModified || 0}`;
}

function rememberUpload(file, uploadId) {
  const map = readPending();
  map[fingerprint(file)] = { uploadId, at: Date.now() };
  // 只留最近 20 条
  const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at);
  writePending(Object.fromEntries(entries.slice(0, 20)));
}

function forgetUpload(file) {
  const map = readPending();
  delete map[fingerprint(file)];
  writePending(map);
}

export function pendingUploads() {
  return Object.entries(readPending()).map(([key, v]) => ({ key, ...v }));
}

export function clearPending() {
  writePending({});
}

/* ------------------------------------------------------------------ */
/* 媒体信息探测（时长 / 波形）                                          */
/* ------------------------------------------------------------------ */

/**
 * 读取音频的真实时长；如果是短音频（语音消息），顺便解码出波形峰值。
 * 解析失败不报错，只是没有波形而已，用原生播放器兜底。
 * @param {File|Blob} blob
 * @param {{maxSecondsForWaveform?: number}} [opts]
 */
export async function probeAudio(blob, { maxSecondsForWaveform = 300 } = {}) {
  const out = { durationMs: null, waveform: null };

  // 时长：先用 <audio> 元数据，兼容性最好
  try {
    out.durationMs = await new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('audio');
      const done = (v) => {
        URL.revokeObjectURL(url);
        a.src = '';
        resolve(v);
      };
      a.preload = 'metadata';
      a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : null);
      a.onerror = () => done(null);
      setTimeout(() => done(null), 6000);
      a.src = url;
    });
  } catch {
    /* 保持 null */
  }

  if (!out.durationMs || out.durationMs > maxSecondsForWaveform * 1000) return out;

  // 波形：只在文件不大的时候做，避免把几百 MB 的音频读进内存
  if (blob.size > 12 * 1024 * 1024) return out;

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return out;
    const ctx = new Ctx();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ch = buf.getChannelData(0);
    const bars = 48;
    const step = Math.floor(ch.length / bars) || 1;
    const peaks = [];
    for (let i = 0; i < bars; i += 1) {
      let peak = 0;
      const start = i * step;
      // 每段抽样 200 个点就够，全量遍历对长音频太慢
      const stride = Math.max(1, Math.floor(step / 200));
      for (let j = start; j < start + step && j < ch.length; j += stride) {
        const v = Math.abs(ch[j]);
        if (v > peak) peak = v;
      }
      peaks.push(peak);
    }
    const max = Math.max(...peaks, 0.0001);
    out.waveform = peaks.map((p) => Number((p / max).toFixed(3)));
    if (!out.durationMs) out.durationMs = Math.round(buf.duration * 1000);
    await ctx.close();
  } catch {
    /* 解码失败就没波形 */
  }

  return out;
}

/** 视频时长 */
export async function probeVideo(blob) {
  try {
    return await new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      const done = (val) => {
        URL.revokeObjectURL(url);
        v.src = '';
        resolve(val);
      };
      v.preload = 'metadata';
      v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null);
      v.onerror = () => done(null);
      setTimeout(() => done(null), 6000);
      v.src = url;
    });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

class UploadCancelled extends Error {
  constructor() {
    super('上传已取消');
    this.name = 'UploadCancelled';
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new UploadCancelled());
      },
      { once: true },
    );
  });

/**
 * 上传一个文件并返回服务端的文件对象。
 *
 * @param {File|Blob} file
 * @param {{
 *   name?: string,
 *   onProgress?: (p: {sent: number, total: number, ratio: number}) => void,
 *   onPhase?: (phase: 'init'|'upload'|'merge'|'done') => void,
 *   signal?: AbortSignal,
 * }} [opts]
 * @returns {Promise<{file: object, meta: object}>}
 */
export async function uploadFile(file, opts = {}) {
  const { onProgress, onPhase, signal } = opts;
  const api = (await import('./api.js')).api;
  const name = opts.name || file.name || '未命名文件';

  const throwIfAborted = () => {
    if (signal?.aborted) throw new UploadCancelled();
  };

  onPhase?.('init');
  throwIfAborted();

  // 先看看有没有可以续传的任务
  let session = null;
  const remembered = readPending()[fingerprint({ name, size: file.size, lastModified: file.lastModified })];
  if (remembered?.uploadId) {
    try {
      const s = await api.uploadStatus(remembered.uploadId);
      if (s.size === file.size && s.name === name) session = s;
    } catch {
      forgetUpload({ name, size: file.size, lastModified: file.lastModified });
    }
  }

  if (!session) {
    session = await api.uploadInit({
      name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
    });
    rememberUpload({ name, size: file.size, lastModified: file.lastModified }, session.uploadId);
  }

  throwIfAborted();

  const { uploadId, chunkSize, totalChunks } = session;
  const done = new Set(session.received || []);
  let sent = done.size * chunkSize;
  const total = file.size;
  const report = () => onProgress?.({ sent: Math.min(sent, total), total, ratio: Math.min(1, sent / total) });
  report();

  onPhase?.('upload');

  /** 传单独一片，带重试 */
  async function putChunk(index) {
    const start = index * chunkSize;
    const blob = file.slice(start, Math.min(start + chunkSize, total));
    let lastErr = null;
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      throwIfAborted();
      try {
        await api.uploadChunk(uploadId, index, blob, signal);
        return;
      } catch (err) {
        if (err.name === 'UploadCancelled' || err.name === 'AbortError') throw err;
        lastErr = err;
        // 4xx 除了 408/429 之外重试没意义
        if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) throw err;
        await sleep(400 * 2 ** attempt, signal);
      }
    }
    throw lastErr || new Error(`第 ${index} 块上传失败`);
  }

  // 待传队列
  const queue = [];
  for (let i = 0; i < totalChunks; i += 1) if (!done.has(i)) queue.push(i);

  let cursor = 0;
  const baseChunk = Math.min(chunkSize, total);
  async function worker() {
    for (;;) {
      throwIfAborted();
      const idx = cursor;
      cursor += 1;
      if (idx >= queue.length) return;
      const index = queue[idx];
      await putChunk(index);
      sent += index === totalChunks - 1 ? total - index * chunkSize : baseChunk;
      report();
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));
  } catch (err) {
    if (err instanceof UploadCancelled) {
      // 主动取消：把服务端的临时块也清掉
      api.uploadAbort(uploadId).catch(() => {});
      forgetUpload({ name, size: file.size, lastModified: file.lastModified });
    }
    // 其他错误保留 localStorage 记录，下次可以续传
    throw err;
  }

  throwIfAborted();
  onPhase?.('merge');

  let result;
  try {
    result = await api.uploadComplete(uploadId);
  } catch (err) {
    // 服务端说还缺块：补齐后再合并一次
    if (err.status === 409 && Array.isArray(err.payload?.missing)) {
      for (const index of err.payload.missing) {
        await putChunk(index);
      }
      result = await api.uploadComplete(uploadId);
    } else {
      throw err;
    }
  }

  forgetUpload({ name, size: file.size, lastModified: file.lastModified });
  onProgress?.({ sent: total, total, ratio: 1 });
  onPhase?.('done');

  // 媒体元信息：时长和波形由服务端原样存进消息 meta
  let meta = null;
  try {
    if (result.file.kind === 'audio') {
      const p = await probeAudio(file);
      meta = { durationMs: p.durationMs, waveform: p.waveform };
    } else if (result.file.kind === 'video') {
      meta = { durationMs: await probeVideo(file) };
    }
  } catch {
    /* 探测失败不影响发送 */
  }

  return { file: result.file, meta };
}

export { UploadCancelled };
