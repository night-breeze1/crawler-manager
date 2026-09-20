'use strict';

/* ============================================================
 * 歌词滚动视频生成器 — 核心逻辑（优化版）
 *
 * 新增功能：
 *   1. MP3 文件名自动解析（歌曲名-歌手名-专辑名，专辑可省略）
 *   2. 独立录制画布，仅录制歌词滚动区域
 *   3. 视频格式选择框（WebM VP9 / VP8 / MP4 H.264）
 *
 * 技术方案：
 *   - 主画布：完整播放器界面预览（黑胶+歌词+进度条）
 *   - 录制画布：仅渲染歌词区域，captureStream 输出视频流
 *   - AudioContext 分流：扬声器播放 + MediaStreamDestination 录制
 * ============================================================ */

// ===== 全局配置 =====
const CONFIG = {
  vinylRotationSpeed: 0.8,   // 唱片旋转速度（弧度/秒）
  lyricLerpFactor: 0.12,     // 歌词平滑滚动系数（0~1，越大越快）
  lyricVisibleRange: 5,      // 歌词可见行数范围（录制画布纵向更长，多显示几行）
  vinylGrooveCount: 40,      // 唱片纹路数量
};

// ===== 视频格式选项 =====
// MP4 选项始终显示，录制时若浏览器不支持则自动降级为 WebM
const VIDEO_FORMATS = [
  { id: 'auto',      label: '自动选择',       mime: null,                            ext: null },
  { id: 'mp4-h264',  label: 'MP4 (H.264)',   mime: 'video/mp4;codecs=h264,aac',     ext: 'mp4' },
  { id: 'mp4-plain', label: 'MP4 (默认编码)', mime: 'video/mp4',                     ext: 'mp4' },
  { id: 'webm-vp9',  label: 'WebM (VP9)',    mime: 'video/webm;codecs=vp9,opus',    ext: 'webm' },
  { id: 'webm-vp8',  label: 'WebM (VP8)',    mime: 'video/webm;codecs=vp8,opus',    ext: 'webm' },
];

// ===== 颜色配置 =====
const COLORS = {
  bgTop: '#1e1818',
  bgBottom: '#151010',
  textWhite: '#ffffff',
  textGray: '#8a8080',
  textDark: '#555050',
  vinylGrooveLight: 'rgba(40, 35, 35, 0.25)',
  vinylGrooveDark: 'rgba(5, 4, 4, 0.30)',
  progressBar: 'rgba(255, 255, 255, 0.6)',
  progressTrack: 'rgba(255, 255, 255, 0.10)',
};

// 统一字体栈（含中文字体回退）
const FONT_FAMILY = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif';

// ===== 工具函数 =====

/** 缓动函数：先快后慢 */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** 秒数格式化为 mm:ss */
function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 从文件名解析歌曲信息
 * 格式：歌曲名-歌手名-专辑名（专辑可省略）
 * 例如："最美的太阳-张杰-最美的太阳.mp3" → { title, artist, album }
 *       "晴天-周杰伦.mp3" → { title, artist, album:'' }
 */
function parseFilename(filename) {
  // 去除扩展名
  const baseName = filename.replace(/\.[^.]+$/, '');
  // 按 "-" 分割并去除首尾空格
  const parts = baseName.split('-').map(s => s.trim()).filter(s => s.length > 0);

  const result = { title: '', artist: '', album: '' };

  if (parts.length >= 3) {
    // 歌曲名-歌手名-专辑名
    result.title = parts[0];
    result.artist = parts[1];
    result.album = parts[2];
  } else if (parts.length === 2) {
    // 歌曲名-歌手名（无专辑）
    result.title = parts[0];
    result.artist = parts[1];
  } else if (parts.length === 1) {
    // 只有歌曲名
    result.title = parts[0];
  }

  return result;
}

/** 绘制圆角矩形路径（兼容性辅助函数） */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ===== LRC 歌词解析 =====

/**
 * 解析 LRC 歌词文本
 * 支持格式：[mm:ss.xx]歌词，无时间戳的行标记 time=-1 待分配
 */
function parseLRC(text) {
  const lines = text.split('\n');
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  const lyrics = [];

  for (const line of lines) {
    const matches = [...line.matchAll(timeRegex)];
    const content = line.replace(timeRegex, '').trim();
    if (!content) continue;

    if (matches.length > 0) {
      for (const m of matches) {
        const min = parseInt(m[1]);
        const sec = parseInt(m[2]);
        const ms = m[3] ? parseInt(m[3].padEnd(3, '0')) : 0;
        lyrics.push({ time: min * 60 + sec + ms / 1000, text: content });
      }
    } else {
      lyrics.push({ time: -1, text: content });
    }
  }

  const hasTimestamps = lyrics.some(l => l.time >= 0);
  if (hasTimestamps) {
    return lyrics.filter(l => l.time >= 0).sort((a, b) => a.time - b.time);
  }
  return lyrics;
}

/** 将无时间戳歌词按时长均匀分配 */
function distributeLyrics(lyrics, duration) {
  if (lyrics.length === 0 || duration <= 0) return lyrics;
  if (lyrics.some(l => l.time >= 0)) {
    return lyrics.filter(l => l.time >= 0).sort((a, b) => a.time - b.time);
  }
  const interval = duration / (lyrics.length + 1);
  return lyrics.map((l, i) => ({ time: interval * (i + 1), text: l.text }));
}

// ===== 黑胶唱片绘制器 =====

class VinylDrawer {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** 绘制完整的黑胶唱片（含唱臂） */
  draw(cx, cy, radius, rotation, progress, coverImage, songTitle) {
    this.drawDisc(cx, cy, radius, rotation);
    this.drawCenterLabel(cx, cy, radius * 0.35, coverImage, songTitle);
    this.drawTonearm(cx, cy, radius, progress);
  }

  /** 绘制唱片盘体（纹路 + 高光） */
  drawDisc(cx, cy, radius, rotation) {
    const ctx = this.ctx;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 12;

    const grad = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius);
    grad.addColorStop(0, '#1a1414');
    grad.addColorStop(0.6, '#0d0a0a');
    grad.addColorStop(1, '#050404');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 同心圆纹路（跟随旋转）
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    for (let i = 0; i < CONFIG.vinylGrooveCount; i++) {
      const r = radius * (0.38 + (i / CONFIG.vinylGrooveCount) * 0.58);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = i % 2 === 0 ? COLORS.vinylGrooveLight : COLORS.vinylGrooveDark;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
    ctx.restore();

    // 固定高光反射
    ctx.save();
    ctx.translate(cx, cy);
    const shineGrad = ctx.createLinearGradient(-radius, -radius, radius, radius);
    shineGrad.addColorStop(0, 'rgba(255,255,255,0)');
    shineGrad.addColorStop(0.42, 'rgba(255,255,255,0)');
    shineGrad.addColorStop(0.48, 'rgba(255,255,255,0.07)');
    shineGrad.addColorStop(0.52, 'rgba(255,255,255,0.07)');
    shineGrad.addColorStop(0.58, 'rgba(255,255,255,0)');
    shineGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shineGrad;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 绘制中心标签 */
  drawCenterLabel(cx, cy, radius, coverImage, songTitle) {
    const ctx = this.ctx;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    if (coverImage && coverImage.complete && coverImage.naturalWidth > 0) {
      const img = coverImage;
      const scale = Math.max(radius * 2 / img.width, radius * 2 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    } else {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, '#3a2828');
      grad.addColorStop(1, '#1a1010');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

      ctx.fillStyle = 'rgba(200, 180, 180, 0.5)';
      ctx.font = `bold ${radius}px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(songTitle ? songTitle[0] : '♪', cx, cy);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /** 绘制唱臂 */
  drawTonearm(cx, cy, radius, progress) {
    const ctx = this.ctx;

    const baseX = cx + radius * 1.15;
    const baseY = cy - radius * 1.05;
    const needleR = radius * (0.78 - progress * 0.33);
    const needleAngle = -Math.PI / 4 + progress * 0.12;
    const needleX = cx + Math.cos(needleAngle) * needleR;
    const needleY = cy + Math.sin(needleAngle) * needleR;

    ctx.save();

    ctx.fillStyle = '#2a2424';
    ctx.beginPath();
    ctx.arc(baseX, baseY, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4a4040';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#3a3030';
    ctx.beginPath();
    ctx.arc(baseX, baseY, 6, 0, Math.PI * 2);
    ctx.fill();

    const ctrlX = (baseX + needleX) / 2 + radius * 0.08;
    const ctrlY = (baseY + needleY) / 2 - radius * 0.15;

    ctx.strokeStyle = '#d8d0d0';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.quadraticCurveTo(ctrlX, ctrlY, needleX, needleY);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.quadraticCurveTo(ctrlX, ctrlY, needleX, needleY);
    ctx.stroke();

    ctx.fillStyle = '#1a1515';
    ctx.beginPath();
    ctx.arc(needleX, needleY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }
}

// ===== 歌词渲染器 =====
// 修改：render / drawText 接受 ctx 参数，支持向不同画布渲染

class LyricRenderer {
  constructor() {
    this.lyrics = [];
    this.displayLinePos = 0;  // 浮点位置，用于平滑滚动
    this.currentIndex = 0;
  }

  /** 设置歌词数据 */
  setLyrics(lyrics) {
    this.lyrics = lyrics;
    this.displayLinePos = 0;
    this.currentIndex = 0;
  }

  /** 根据播放时间更新歌词滚动状态（lerp 插值平滑过渡） */
  update(currentTime) {
    if (this.lyrics.length === 0) return;

    let newIndex = 0;
    for (let i = this.lyrics.length - 1; i >= 0; i--) {
      if (currentTime >= this.lyrics[i].time) {
        newIndex = i;
        break;
      }
    }
    this.currentIndex = newIndex;

    const diff = newIndex - this.displayLinePos;
    this.displayLinePos += diff * CONFIG.lyricLerpFactor;
    if (Math.abs(diff) < 0.005) {
      this.displayLinePos = newIndex;
    }
  }

  /**
   * 渲染歌词区域（可向任意 ctx 渲染）
   * 当前行白色加粗居中，其余行灰色并随距离淡出
   */
  render(ctx, centerX, centerY, areaWidth, fontScale) {
    if (this.lyrics.length === 0) return;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lineHeight = 48 * fontScale;
    const visibleRange = CONFIG.lyricVisibleRange;

    const startIdx = Math.max(0, Math.floor(this.displayLinePos - visibleRange));
    const endIdx = Math.min(
      this.lyrics.length - 1,
      Math.ceil(this.displayLinePos + visibleRange)
    );

    for (let i = startIdx; i <= endIdx; i++) {
      const line = this.lyrics[i];
      const offset = i - this.displayLinePos;
      const y = centerY + offset * lineHeight;
      const distance = Math.abs(offset);

      const alpha = Math.max(0, 1 - distance / (visibleRange + 0.5));
      const isCurrent = distance < 0.5;

      let fontSize, fontWeight, color;

      if (isCurrent) {
        fontSize = Math.round(26 * fontScale);
        fontWeight = 'bold';
        color = `rgba(255, 255, 255, ${alpha})`;
      } else {
        fontSize = Math.max(12, Math.round((20 - distance * 1.5) * fontScale));
        fontWeight = 'normal';
        const gray = Math.round(140 - distance * 25);
        color = `rgba(${gray}, ${gray - 5}, ${gray - 10}, ${alpha * 0.75})`;
      }

      ctx.font = `${fontWeight} ${fontSize}px ${FONT_FAMILY}`;
      ctx.fillStyle = color;
      this.drawText(ctx, line.text, centerX, y, areaWidth - 40, fontSize, fontWeight);
    }
  }

  /** 绘制单行歌词，超宽时自动缩小字号 */
  drawText(ctx, text, x, y, maxWidth, fontSize, fontWeight) {
    let size = fontSize;
    while (size > 10 && ctx.measureText(text).width > maxWidth) {
      size -= 1;
      ctx.font = `${fontWeight} ${size}px ${FONT_FAMILY}`;
    }
    ctx.fillText(text, x, y);
  }
}

// ===== 主应用 =====

class LyricVideoApp {
  constructor() {
    // 状态
    this.vinylRotation = 0;
    this.coverImage = null;
    this.lyrics = [];
    this.rawLyrics = null;
    this.rawLrcText = '';       // 原始 LRC 文本（发送给后端用）
    this.audioFile = null;      // 音频文件引用（发送给后端用）
    this.isRecording = false;
    this.animationId = null;
    this.lastFrameTime = 0;

    // 进度条拖动状态
    this.isDraggingProgress = false;
    this.hoverProgress = false;

    // 音频录制相关
    this.audioCtx = null;
    this.audioSource = null;
    this.audioDest = null;
    this.recorder = null;
    this.chunks = [];
    this.prevAudioUrl = null;

    // 快速生成相关
    this.fastTaskId = null;
    this.fastPollTimer = null;
    this.backendOnline = false;  // 后端是否在线

    this.initElements();
    this.initCanvas();
    this.initVideoFormatOptions();
    this.vinylDrawer = new VinylDrawer(this.ctx);
    this.lyricRenderer = new LyricRenderer();
    this.bindEvents();
    this.render();
    this.checkBackendHealth();  // 启动时检测后端
  }

  /** 获取并缓存所有 DOM 元素引用 */
  initElements() {
    this.audio = document.getElementById('audio');
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');

    // 录制画布（独立，仅渲染歌词区域）
    this.recordCanvas = document.getElementById('recordCanvas');
    this.recordCtx = this.recordCanvas.getContext('2d');

    this.audioInput = document.getElementById('audioInput');
    this.lrcInput = document.getElementById('lrcInput');
    this.coverInput = document.getElementById('coverInput');
    this.songTitleInput = document.getElementById('songTitle');
    this.artistInput = document.getElementById('artistName');
    this.albumInput = document.getElementById('albumName');
    this.resolutionSelect = document.getElementById('resolution');
    this.fpsSelect = document.getElementById('fps');
    this.videoFormatSelect = document.getElementById('videoFormat');
    this.recordSizeSelect = document.getElementById('recordSize');

    this.previewBtn = document.getElementById('previewBtn');
    this.generateBtn = document.getElementById('generateBtn');
    this.fastGenerateBtn = document.getElementById('fastGenerateBtn');
    this.statusBar = document.getElementById('statusBar');
    this.progressWrapper = document.getElementById('progressWrapper');
    this.progressFill = document.getElementById('progressFill');
    this.progressLabel = document.getElementById('progressLabel');
    this.progressStatus = document.getElementById('progressStatus');
    this.resultWrapper = document.getElementById('resultWrapper');
    this.resultVideo = document.getElementById('resultVideo');
    this.downloadLink = document.getElementById('downloadLink');
    this.placeholder = document.getElementById('placeholder');

    this.lrcModal = document.getElementById('lrcModal');
    this.lrcTextarea = document.getElementById('lrcTextarea');
    this.pasteLrcBtn = document.getElementById('pasteLrcBtn');
    this.lrcCancelBtn = document.getElementById('lrcCancelBtn');
    this.lrcConfirmBtn = document.getElementById('lrcConfirmBtn');

    this.audioDisplay = document.getElementById('audioDisplay');
    this.lrcDisplay = document.getElementById('lrcDisplay');
    this.coverDisplay = document.getElementById('coverDisplay');
  }

  /** 初始化主画布和录制画布尺寸 */
  initCanvas() {
    this.setResolution(this.resolutionSelect.value);
    this.setRecordSize(this.recordSizeSelect.value);
  }

  /** 设置主画布分辨率（预览用） */
  setResolution(value) {
    const [w, h] = value.split('x').map(Number);
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /** 设置录制画布尺寸（仅歌词区域） */
  setRecordSize(value) {
    const [w, h] = value.split('x').map(Number);
    this.recordCanvas.width = w;
    this.recordCanvas.height = h;
  }

  /**
   * 动态填充视频格式下拉框
   * 所有格式始终显示（MP4 选项不因浏览器不支持而隐藏）
   * 不支持的格式标注提示文字
   */
  initVideoFormatOptions() {
    const select = this.videoFormatSelect;
    select.innerHTML = '';

    for (const fmt of VIDEO_FORMATS) {
      const option = document.createElement('option');
      option.value = fmt.id;

      if (fmt.id === 'auto') {
        // 自动选择始终可用
        option.textContent = fmt.label;
      } else if (MediaRecorder.isTypeSupported(fmt.mime)) {
        option.textContent = fmt.label;
      } else {
        // 标注不支持，录制时会自动降级
        option.textContent = `${fmt.label}（当前浏览器不支持，将降级）`;
      }
      select.appendChild(option);
    }
  }

  /**
   * 根据用户选择获取实际录制的 MIME 类型和扩展名
   * 若用户选择的格式浏览器不支持，自动降级为最佳可用格式
   */
  getSelectedFormat() {
    const id = this.videoFormatSelect.value;
    const fmt = VIDEO_FORMATS.find(f => f.id === id);

    // 自动选择：按优先级探测
    if (!fmt || fmt.id === 'auto' || !fmt.mime) {
      return this.detectBestFormat();
    }

    // 用户选择的格式被支持
    if (MediaRecorder.isTypeSupported(fmt.mime)) {
      return { mime: fmt.mime, ext: fmt.ext, label: fmt.label };
    }

    // 不支持：降级到最佳格式，并通知用户
    const fallback = this.detectBestFormat();
    this.updateStatus(`所选格式不支持，已降级为 ${fallback.label}`);
    return fallback;
  }

  /** 探测浏览器支持的最佳视频格式 */
  detectBestFormat() {
    const candidates = [
      { mime: 'video/mp4;codecs=h264,aac',    ext: 'mp4',  label: 'MP4 (H.264)' },
      { mime: 'video/webm;codecs=vp9,opus',   ext: 'webm', label: 'WebM (VP9)' },
      { mime: 'video/webm;codecs=vp8,opus',   ext: 'webm', label: 'WebM (VP8)' },
      { mime: 'video/webm',                    ext: 'webm', label: 'WebM' },
    ];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    }
    return { mime: 'video/webm', ext: 'webm', label: 'WebM' };
  }

  /** 绑定所有事件监听器 */
  bindEvents() {
    this.audioInput.addEventListener('change', (e) => this.onAudioChange(e.target.files[0]));
    this.lrcInput.addEventListener('change', (e) => this.onLrcChange(e.target.files[0]));
    this.coverInput.addEventListener('change', (e) => this.onCoverChange(e.target.files[0]));

    this.resolutionSelect.addEventListener('change', (e) => {
      if (!this.isRecording) {
        this.setResolution(e.target.value);
        this.render();
      }
    });

    this.recordSizeSelect.addEventListener('change', (e) => {
      if (!this.isRecording) {
        this.setRecordSize(e.target.value);
      }
    });

    this.previewBtn.addEventListener('click', () => this.togglePreview());
    this.generateBtn.addEventListener('click', () => this.startRecording());
    this.fastGenerateBtn.addEventListener('click', () => this.startFastGenerate());

    // 进度条鼠标拖动
    this.canvas.addEventListener('mousedown', (e) => this.onCanvasMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onCanvasMouseMove(e));
    window.addEventListener('mouseup', () => this.onCanvasMouseUp());
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverProgress = false;
      this.canvas.style.cursor = 'default';
      if (!this.isDraggingProgress) this.render();
    });

    this.audio.addEventListener('ended', () => this.onAudioEnded());
    this.audio.addEventListener('loadedmetadata', () => {
      this.updateStatus(`音频已加载，时长 ${formatTime(this.audio.duration)}`);
      this.tryDistributeLyrics();
      this.checkReady();
    });

    // 歌曲信息变化时重绘
    [this.songTitleInput, this.artistInput, this.albumInput].forEach(input => {
      input.addEventListener('input', () => this.render());
    });

    // 歌词粘贴弹窗
    this.pasteLrcBtn.addEventListener('click', () => {
      this.lrcModal.style.display = 'flex';
    });
    this.lrcCancelBtn.addEventListener('click', () => {
      this.lrcModal.style.display = 'none';
    });
    this.lrcConfirmBtn.addEventListener('click', () => {
      const text = this.lrcTextarea.value;
      if (text.trim()) {
        this.loadLyrics(text, '粘贴的歌词');
        this.lrcModal.style.display = 'none';
      }
    });
  }

  // ===== 文件加载 =====

  /**
   * 音频文件加载
   * 自动从文件名解析歌曲信息：歌曲名-歌手名-专辑名
   */
  onAudioChange(file) {
    if (!file) return;
    this.audioFile = file;  // 保存引用供后端上传用
    if (this.prevAudioUrl) {
      URL.revokeObjectURL(this.prevAudioUrl);
    }
    const url = URL.createObjectURL(file);
    this.prevAudioUrl = url;
    this.audio.src = url;
    this.audioDisplay.querySelector('.file-text').textContent = file.name;

    // 从文件名自动解析歌曲信息并填充表单
    const info = parseFilename(file.name);
    if (info.title) this.songTitleInput.value = info.title;
    if (info.artist) this.artistInput.value = info.artist;
    this.albumInput.value = info.album || '';

    this.updateStatus('正在加载音频...');
    this.render();
  }

  onLrcChange(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => this.loadLyrics(e.target.result, file.name);
    reader.readAsText(file, 'utf-8');
    this.lrcDisplay.querySelector('.file-text').textContent = file.name;
  }

  loadLyrics(text, sourceName) {
    this.rawLrcText = text;  // 保存原始文本供后端使用
    this.rawLyrics = parseLRC(text);
    this.lrcDisplay.querySelector('.file-text').textContent = sourceName;
    this.tryDistributeLyrics();
    this.checkReady();
    this.render();
  }

  /** 尝试将无时间戳歌词按时长均匀分配 */
  tryDistributeLyrics() {
    if (!this.rawLyrics) return;
    if (this.audio.duration && isFinite(this.audio.duration)) {
      this.lyrics = distributeLyrics(this.rawLyrics, this.audio.duration);
    } else if (this.rawLyrics.some(l => l.time >= 0)) {
      this.lyrics = this.rawLyrics.filter(l => l.time >= 0)
        .sort((a, b) => a.time - b.time);
    } else {
      this.lyrics = this.rawLyrics;
    }
    this.lyricRenderer.setLyrics(this.lyrics);
  }

  onCoverChange(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    this.coverImage = new Image();
    this.coverImage.onload = () => this.render();
    this.coverImage.src = url;
    this.coverDisplay.querySelector('.file-text').textContent = file.name;
  }

  // ===== 状态管理 =====

  checkReady() {
    const ready = this.audio.src && this.lyrics.length > 0;
    this.previewBtn.disabled = !ready;
    this.generateBtn.disabled = !ready || this.isRecording;
    this.fastGenerateBtn.disabled = !ready || this.isRecording;
    if (ready && this.placeholder) {
      this.placeholder.style.display = 'none';
    }
  }

  /** 检测 Python 后端是否在线 */
  async checkBackendHealth() {
    try {
      const resp = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        this.backendOnline = true;
        this.fastGenerateBtn.title = '';
        this.fastGenerateBtn.classList.remove('btn-disabled-hint');
        this.updateStatus('就绪 — 请选择音频和歌词文件（后端已连接，可使用快速生成）');
        return;
      }
    } catch {
      // 后端不可达
    }
    this.backendOnline = false;
    this.fastGenerateBtn.title = '需要启动 Python 后端：python3 backend.py，然后访问 http://localhost:5000';
    this.fastGenerateBtn.classList.add('btn-disabled-hint');
  }

  updateStatus(msg) {
    this.statusBar.textContent = msg;
  }

  updateProgress(pct, statusText) {
    this.progressFill.style.width = `${pct}%`;
    this.progressLabel.textContent = `${Math.round(pct)}%`;
    if (statusText !== undefined) {
      this.progressStatus.textContent = statusText;
    }
  }

  // ===== 预览播放 =====

  togglePreview() {
    if (this.isRecording) return;
    if (this.audio.paused) {
      this.startPreview();
    } else {
      this.pausePreview();
    }
  }

  async startPreview() {
    await this.ensureAudioContext();
    await this.audioCtx.resume();
    await this.audio.play();
    this.previewBtn.textContent = '暂停';
    this.updateStatus('预览播放中...');
    this.startLoop();
  }

  pausePreview() {
    this.audio.pause();
    this.previewBtn.textContent = '预览';
    this.updateStatus('已暂停');
  }

  // ===== 视频录制 =====

  async startRecording() {
    if (this.isRecording) return;

    // 检查浏览器兼容性
    if (!this.recordCanvas.captureStream || !window.MediaRecorder) {
      this.updateStatus('当前浏览器不支持视频录制，请使用 Chrome 或 Firefox');
      return;
    }

    // 停止预览
    if (!this.audio.paused) {
      this.audio.pause();
    }

    // 重置到开头
    this.audio.currentTime = 0;

    await this.ensureAudioContext();
    await this.audioCtx.resume();

    // 从录制画布获取视频流（仅歌词区域）
    const fps = parseInt(this.fpsSelect.value);
    const canvasStream = this.recordCanvas.captureStream(fps);
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...this.audioDest.stream.getAudioTracks(),
    ]);

    // 获取用户选择的视频格式
    const format = this.getSelectedFormat();

    this.recorder = new MediaRecorder(combinedStream, {
      mimeType: format.mime,
      videoBitsPerSecond: 8_000_000,
    });
    this.chunks = [];

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => this.onRecordingStop(format);

    // 更新 UI
    this.isRecording = true;
    this.generateBtn.disabled = true;
    this.generateBtn.textContent = '录制中...';
    this.previewBtn.disabled = true;
    this.fastGenerateBtn.disabled = true;
    this.progressWrapper.style.display = 'flex';
    this.resultWrapper.style.display = 'none';
    this.resolutionSelect.disabled = true;
    this.fpsSelect.disabled = true;
    this.recordSizeSelect.disabled = true;
    this.videoFormatSelect.disabled = true;

    // 开始录制并播放
    this.recorder.start(100);
    await this.audio.play();
    this.updateStatus(`正在录制视频（${format.label}）...`);
    this.startLoop();
  }

  // ===== 进度条拖动交互 =====

  /** 获取画布上鼠标对应的内部坐标（考虑 CSS 缩放） */
  getCanvasMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  /** 获取进度条在画布上的矩形区域 */
  getProgressBarBounds() {
    const layout = this.getLayout();
    const scale = layout.fontScale;
    return {
      x: layout.progress.x,
      y: layout.progress.y - 12 * scale,
      w: layout.progress.width,
      h: 28 * scale,
    };
  }

  /** 判断坐标是否在进度条范围内 */
  isPointOnProgressBar(x, y) {
    const b = this.getProgressBarBounds();
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }

  /** 鼠标按下：若在进度条上则开始拖动并跳转 */
  onCanvasMouseDown(e) {
    if (!this.audio.src || this.isRecording) return;
    const pos = this.getCanvasMousePos(e);
    if (this.isPointOnProgressBar(pos.x, pos.y)) {
      this.isDraggingProgress = true;
      this.seekToPosition(pos.x);
    }
  }

  /** 鼠标移动：拖动时跳转，悬停时切换光标 */
  onCanvasMouseMove(e) {
    if (!this.audio.src || this.isRecording) return;
    const pos = this.getCanvasMousePos(e);

    if (this.isDraggingProgress) {
      this.seekToPosition(pos.x);
      return;
    }

    // 悬停检测
    const onBar = this.isPointOnProgressBar(pos.x, pos.y);
    if (onBar !== this.hoverProgress) {
      this.hoverProgress = onBar;
      this.canvas.style.cursor = onBar ? 'pointer' : 'default';
      this.render();
    }
  }

  /** 鼠标抬起：结束拖动 */
  onCanvasMouseUp() {
    if (this.isDraggingProgress) {
      this.isDraggingProgress = false;
      this.render();
    }
  }

  /** 根据画布 x 坐标跳转音频进度 */
  seekToPosition(x) {
    if (!this.audio.duration || !isFinite(this.audio.duration)) return;
    const b = this.getProgressBarBounds();
    const ratio = Math.max(0, Math.min(1, (x - b.x) / b.w));
    this.audio.currentTime = ratio * this.audio.duration;
    // 拖动时立即更新歌词位置
    this.lyricRenderer.update(this.audio.currentTime);
    this.render();
  }

  /** 音频播放结束时的处理 */
  onAudioEnded() {
    if (this.isRecording) {
      setTimeout(() => {
        if (this.recorder && this.recorder.state === 'recording') {
          this.recorder.stop();
        }
      }, 200);
    } else {
      this.pausePreview();
    }
  }

  /** 录制结束：生成视频文件并展示 */
  async onRecordingStop(format) {
    this.isRecording = false;
    this.stopLoop();

    const blob = new Blob(this.chunks, { type: format.mime });
    const songTitle = this.songTitleInput.value || '歌曲';
    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);

    // MP4 格式：音频实际为 Opus，需发送到后端用 FFmpeg 转为 AAC
    if (format.ext === 'mp4') {
      await this.fixMp4Audio(blob, songTitle, sizeMB, format);
      return;
    }

    // WebM 格式：直接使用
    const url = URL.createObjectURL(blob);
    this.resultVideo.src = url;
    this.downloadLink.href = url;
    this.downloadLink.download = `${songTitle}_歌词视频.${format.ext}`;
    this.downloadLink.textContent = `下载视频 (.${format.ext}, ${sizeMB} MB)`;

    // 隐藏进度条，显示结果区域
    this.progressWrapper.style.display = 'none';
    this.resultWrapper.style.display = 'block';
    this.restoreUIAfterRecording();
    this.updateStatus(`视频生成完成！(${sizeMB} MB, ${format.label}, .${format.ext})`);
  }

  /**
   * 修复 MP4 音频：上传到后端，FFmpeg 将 Opus 转 AAC
   * 视频流直接复制不重编码，秒级完成
   */
  async fixMp4Audio(blob, songTitle, sizeMB, format) {
    // 后端不在线时提示
    if (!this.backendOnline) {
      const url = URL.createObjectURL(blob);
      this.resultVideo.src = url;
      this.downloadLink.href = url;
      this.downloadLink.download = `${songTitle}_歌词视频.${format.ext}`;
      this.downloadLink.textContent = `下载视频 (.${format.ext}, ${sizeMB} MB)`;
      this.restoreUIAfterRecording();
      this.updateStatus(
        `视频已生成 (${sizeMB} MB)，但音频为 Opus 格式可能无法播放。` +
        `请启动后端 (python3 backend.py) 后重新录制，或用快速生成功能。`
      );
      return;
    }

    // 上传到后端修复
    this.updateProgress(95, '修复 MP4 音频编码中...');
    this.progressWrapper.style.display = 'flex';
    this.resultWrapper.style.display = 'none';

    try {
      const formData = new FormData();
      formData.append('video', blob, `${songTitle}.mp4`);

      const resp = await fetch('/api/remux', { method: 'POST', body: formData });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const fixedBlob = await resp.blob();
      const fixedSizeMB = (fixedBlob.size / 1024 / 1024).toFixed(1);
      const url = URL.createObjectURL(fixedBlob);

      this.resultVideo.src = url;
      this.downloadLink.href = url;
      this.downloadLink.download = `${songTitle}_歌词视频.mp4`;
      this.downloadLink.textContent = `下载视频 (.mp4, ${fixedSizeMB} MB)`;

      this.progressWrapper.style.display = 'none';
      this.resultWrapper.style.display = 'block';
      this.restoreUIAfterRecording();
      this.updateStatus(
        `视频生成完成！(${fixedSizeMB} MB, MP4 H.264+AAC, 音频已修复, 进度条可拖动)`
      );
    } catch (e) {
      // 修复失败，提供原始文件下载
      const url = URL.createObjectURL(blob);
      this.resultVideo.src = url;
      this.downloadLink.href = url;
      this.downloadLink.download = `${songTitle}_歌词视频.mp4`;
      this.downloadLink.textContent = `下载视频 (.mp4, ${sizeMB} MB)`;
      this.progressWrapper.style.display = 'none';
      this.resultWrapper.style.display = 'block';
      this.restoreUIAfterRecording();
      this.updateStatus(`音频修复失败: ${e.message}，已提供原始文件（音频可能无法播放）`);
    }
  }

  /** 录制结束后恢复 UI 状态 */
  restoreUIAfterRecording() {
    this.generateBtn.disabled = false;
    this.generateBtn.textContent = '浏览器录制';
    this.previewBtn.disabled = false;
    this.fastGenerateBtn.disabled = !this.audio.src;
    this.resolutionSelect.disabled = false;
    this.fpsSelect.disabled = false;
    this.recordSizeSelect.disabled = false;
    this.videoFormatSelect.disabled = false;
    this.previewBtn.textContent = '预览';
  }

  // ===== 快速生成（Python 后端 + FFmpeg） =====

  /** 状态文案映射 */
  static FAST_STATUS_MAP = {
    'pending':   '等待中...',
    'parsing':   '解析歌词...',
    'computing': '计算帧位置...',
    'rendering': '渲染帧...',
    'encoding':  'FFmpeg 合成中...',
    'done':      '完成',
    'error':     '错误',
  };

  /** 启动快速生成：上传文件到后端，轮询进度 */
  async startFastGenerate() {
    if (!this.audioFile || !this.rawLrcText) {
      this.updateStatus('请先选择音频和歌词文件');
      return;
    }

    // 后端未在线时给出明确提示
    if (!this.backendOnline) {
      this.updateStatus('后端未连接！请先启动 Python 后端：在终端运行 python3 backend.py，然后通过 http://localhost:5000 访问页面');
      return;
    }

    // 禁用按钮
    this.fastGenerateBtn.disabled = true;
    this.fastGenerateBtn.textContent = '生成中...';
    this.generateBtn.disabled = true;
    this.previewBtn.disabled = true;
    this.progressWrapper.style.display = 'flex';
    this.resultWrapper.style.display = 'none';
    this.updateProgress(0, '上传文件中...');

    try {
      // 构建 FormData 上传
      const formData = new FormData();
      formData.append('audio', this.audioFile);
      formData.append('lrc', this.rawLrcText);
      formData.append('title', this.songTitleInput.value || '');
      formData.append('artist', this.artistInput.value || '');
      formData.append('album', this.albumInput.value || '');

      // 使用录制尺寸作为输出尺寸
      const [w, h] = this.recordSizeSelect.value.split('x');
      formData.append('width', w);
      formData.append('height', h);
      formData.append('fps', this.fpsSelect.value);

      // 发送到后端
      const resp = await fetch('/api/render', { method: 'POST', body: formData });
      // 检查响应类型，避免收到 HTML 时 JSON 解析报错
      const contentType = resp.headers.get('content-type') || '';
      if (!resp.ok || !contentType.includes('application/json')) {
        const text = await resp.text().catch(() => '');
        throw new Error(
          `后端返回非 JSON 响应 (HTTP ${resp.status})。` +
          `请确认后端已启动且通过 http://localhost:5000 访问。`
        );
      }

      const data = await resp.json();
      this.fastTaskId = data.task_id;
      this.updateStatus('后端渲染中...');
      this.updateProgress(1, '已提交任务');

      // 开始轮询
      this.pollFastStatus();
    } catch (e) {
      // 更友好的错误提示
      const msg = e.message.includes('Failed to fetch') || e.message.includes('NetworkError')
        ? '无法连接后端！请确认已运行 python3 backend.py，并通过 http://localhost:5000 访问页面'
        : `快速生成失败: ${e.message}`;
      this.updateStatus(msg);
      this.fastGenerateBtn.disabled = !this.audio.src;
      this.fastGenerateBtn.textContent = '快速生成 (MP4)';
      this.generateBtn.disabled = !this.audio.src || this.isRecording;
      this.previewBtn.disabled = !this.audio.src || this.isRecording;
      this.progressWrapper.style.display = 'none';
      // 重新检测后端状态
      this.checkBackendHealth();
    }
  }

  /** 轮询后端渲染进度 */
  pollFastStatus() {
    if (this.fastPollTimer) clearTimeout(this.fastPollTimer);

    const poll = async () => {
      try {
        const resp = await fetch(`/api/status/${this.fastTaskId}`);
        if (!resp.ok) return;
        const task = await resp.json();

        const statusText = LyricVideoApp.FAST_STATUS_MAP[task.status] || task.status;
        this.updateProgress(task.progress || 0, statusText);

        if (task.status === 'done') {
          this.onFastComplete(task);
          return;
        }

        if (task.status === 'error') {
          this.onFastError(task);
          return;
        }

        // 继续轮询（每 1.5 秒）
        this.fastPollTimer = setTimeout(poll, 1500);
      } catch {
        // 网络错误时延迟重试
        this.fastPollTimer = setTimeout(poll, 3000);
      }
    };

    poll();
  }

  /** 快速生成完成 */
  onFastComplete(task) {
    const sizeMB = (task.file_size / 1024 / 1024).toFixed(1);
    const downloadUrl = `/api/download/${this.fastTaskId}`;

    this.resultVideo.src = downloadUrl;
    this.downloadLink.href = downloadUrl;
    this.downloadLink.download = task.filename || '歌词视频.mp4';
    this.downloadLink.textContent = `下载视频 (.mp4, ${sizeMB} MB)`;

    this.fastGenerateBtn.disabled = false;
    this.fastGenerateBtn.textContent = '快速生成 (MP4)';
    this.generateBtn.disabled = !this.audio.src || this.isRecording;
    this.previewBtn.disabled = !this.audio.src || this.isRecording;
    this.progressWrapper.style.display = 'none';
    this.resultWrapper.style.display = 'block';

    this.updateStatus(`视频生成完成！(${sizeMB} MB, MP4 H.264+AAC, 进度条可拖动)`);
  }

  /** 快速生成出错 */
  onFastError(task) {
    this.fastGenerateBtn.disabled = false;
    this.fastGenerateBtn.textContent = '快速生成 (MP4)';
    this.generateBtn.disabled = !this.audio.src || this.isRecording;
    this.previewBtn.disabled = !this.audio.src || this.isRecording;
    this.progressWrapper.style.display = 'none';
    this.updateStatus(`生成失败: ${task.error || '未知错误'}`);
  }

  // ===== AudioContext 管理 =====

  /** 确保音频上下文已初始化（MediaElementSource 只能创建一次） */
  async ensureAudioContext() {
    if (this.audioCtx) return;

    this.audioCtx = new AudioContext();
    this.audioSource = this.audioCtx.createMediaElementSource(this.audio);
    // 扬声器输出
    this.audioSource.connect(this.audioCtx.destination);
    // 录制目标输出
    this.audioDest = this.audioCtx.createMediaStreamDestination();
    this.audioSource.connect(this.audioDest);
  }

  // ===== 动画循环 =====

  startLoop() {
    if (this.animationId) return;
    this.lastFrameTime = performance.now();
    const loop = () => {
      this.animate();
      this.animationId = requestAnimationFrame(loop);
    };
    this.animationId = requestAnimationFrame(loop);
  }

  stopLoop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /** 每帧更新：唱片旋转、歌词滚动、进度、重绘两个画布 */
  animate() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    if (!this.audio.paused) {
      this.vinylRotation += dt * CONFIG.vinylRotationSpeed;
    }

    // 歌词同步
    this.lyricRenderer.update(this.audio.currentTime);

    // 录制进度
    if (this.isRecording && this.audio.duration) {
      this.updateProgress((this.audio.currentTime / this.audio.duration) * 100);
    }

    // 渲染主画布（预览）和录制画布
    this.render();
    this.renderRecordCanvas();
  }

  // ===== 主画布渲染（完整播放器界面，用于预览） =====

  /** 计算主画布布局参数 */
  getLayout() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const fontScale = h / 720;

    return {
      vinyl: {
        cx: w * 0.22,
        cy: h * 0.42,
        radius: Math.min(w * 0.18, h * 0.28),
      },
      info: { x: w * 0.42, y: h * 0.10 },
      lyrics: { cx: w * 0.68, cy: h * 0.50, width: w * 0.52 },
      progress: { x: w * 0.04, y: h * 0.93, width: w * 0.92 },
      fontScale,
    };
  }

  /** 主画布渲染入口 */
  render() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const layout = this.getLayout();

    this.drawBackground(this.ctx, w, h);

    const progress = this.audio.duration
      ? this.audio.currentTime / this.audio.duration
      : 0;
    this.vinylDrawer.draw(
      layout.vinyl.cx, layout.vinyl.cy, layout.vinyl.radius,
      this.vinylRotation, progress,
      this.coverImage, this.songTitleInput.value
    );

    this.drawSongInfo(layout.info.x, layout.info.y, layout.fontScale);
    this.drawTabs(layout.info.x, layout.info.y + 60 * layout.fontScale, layout.fontScale);

    this.lyricRenderer.render(
      this.ctx, layout.lyrics.cx, layout.lyrics.cy,
      layout.lyrics.width, layout.fontScale
    );

    this.drawProgressBar(
      this.ctx, layout.progress.x, layout.progress.y,
      layout.progress.width, layout.fontScale
    );
  }

  drawBackground(ctx, w, h) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, COLORS.bgTop);
    grad.addColorStop(1, COLORS.bgBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.8);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  drawSongInfo(x, y, scale) {
    const ctx = this.ctx;
    const title = this.songTitleInput.value || '未知歌曲';

    ctx.font = `bold ${Math.round(30 * scale)}px ${FONT_FAMILY}`;
    ctx.fillStyle = COLORS.textWhite;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, x, y);

    const titleWidth = ctx.measureText(title).width;
    const tagX = x + titleWidth + 14 * scale;
    const tagY = y + 5 * scale;
    const tagW = 42 * scale;
    const tagH = 22 * scale;

    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, tagX, tagY, tagW, tagH, 4 * scale);
    ctx.fill();

    ctx.fillStyle = '#aaa';
    ctx.font = `${Math.round(12 * scale)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MV', tagX + tagW / 2, tagY + tagH / 2);

    const album = this.albumInput.value || '未知专辑';
    const artist = this.artistInput.value || '未知歌手';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COLORS.textGray;
    ctx.font = `${Math.round(14 * scale)}px ${FONT_FAMILY}`;
    ctx.fillText(`${album}  ${artist}`, x, y + 42 * scale);
  }

  drawTabs(x, y, scale) {
    const ctx = this.ctx;
    const tabs = ['歌词', '百科', '相似推荐'];

    ctx.font = `${Math.round(14 * scale)}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';

    let offsetX = 0;
    for (let i = 0; i < tabs.length; i++) {
      const text = tabs[i];
      const tw = ctx.measureText(text).width;
      const padding = 14 * scale;
      const tabW = tw + padding * 2;
      const tabH = 30 * scale;

      if (i === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        roundRect(ctx, x + offsetX, y, tabW, tabH, tabH / 2);
        ctx.fill();
        ctx.fillStyle = COLORS.textWhite;
      } else {
        ctx.fillStyle = COLORS.textDark;
      }

      ctx.textAlign = 'center';
      ctx.fillText(text, x + offsetX + tabW / 2, y + tabH / 2);
      offsetX += tabW + 10 * scale;
    }
  }

  drawProgressBar(ctx, x, y, width, scale) {
    const progress = this.audio.duration
      ? this.audio.currentTime / this.audio.duration
      : 0;

    // 悬停或拖动时进度条加粗加亮
    const active = this.hoverProgress || this.isDraggingProgress;
    const barHeight = active ? 4 * scale : 3 * scale;

    ctx.fillStyle = COLORS.progressTrack;
    ctx.fillRect(x, y, width, barHeight);

    ctx.fillStyle = active
      ? 'rgba(255, 255, 255, 0.85)'
      : COLORS.progressBar;
    ctx.fillRect(x, y, width * progress, barHeight);

    if (progress > 0) {
      ctx.beginPath();
      ctx.arc(x + width * progress, y + barHeight / 2, 5 * scale, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }

    ctx.font = `${Math.round(12 * scale)}px ${FONT_FAMILY}`;
    ctx.fillStyle = COLORS.textGray;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(this.audio.currentTime || 0), x, y + 12 * scale);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(this.audio.duration || 0), x + width, y + 12 * scale);
  }

  // ===== 录制画布渲染（仅歌词滚动区域） =====

  /**
   * 渲染录制画布：仅包含背景 + 歌词
   * 对应截图中红色框选区域 — 不含标题、黑胶、标签页、进度条
   */
  renderRecordCanvas() {
    const ctx = this.recordCtx;
    const w = this.recordCanvas.width;
    const h = this.recordCanvas.height;

    // 背景
    this.drawBackground(ctx, w, h);

    // 字号缩放基准：以短边 720 为基准
    const fontScale = Math.min(w, h) / 720;

    // 歌词居中渲染（画面唯一内容）
    this.lyricRenderer.render(
      ctx, w / 2, h * 0.5, w * 0.88, fontScale
    );
  }
}

// ===== 启动 =====
window.addEventListener('DOMContentLoaded', () => {
  window.app = new LyricVideoApp();
});
