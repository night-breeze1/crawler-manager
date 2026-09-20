#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
歌词滚动视频生成器 — Python 后端
=================================
使用 Pillow 逐帧渲染 + FFmpeg 合成，生成标准 MP4 (H.264 + AAC)。
相比浏览器 MediaRecorder 方案：
  1. 速度快（多核并行渲染，不受音频时长限制）
  2. 音频为 AAC 编码（所有播放器兼容）
  3. 自带索引（进度条可拖动）
"""

import os
import re
import sys
import json
import uuid
import shutil
import subprocess
import threading
import multiprocessing
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor
from flask import Flask, request, jsonify, send_file, send_from_directory
from PIL import Image, ImageDraw, ImageFont

# ===== 路径配置 =====
BASE_DIR = Path(__file__).parent.resolve()
# data 目录与 lyric-video-generator 同级，避免在盘符根目录下生成数据
DATA_DIR = BASE_DIR.parent / "data" / "user" / "work"
TEMP_DIR = DATA_DIR / "lyric_render"
OUTPUT_DIR = DATA_DIR / "lyric_output"
TEMP_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ===== FFmpeg / ffprobe 路径检测 =====
# 优先使用系统 PATH 中的 ffmpeg，找不到时回退到项目内 ffmpeg/ 目录
FFMPEG_DIR = BASE_DIR / 'ffmpeg'
_IS_WINDOWS = sys.platform == 'win32'
_EXE_SUFFIX = '.exe' if _IS_WINDOWS else ''


def _find_executable(name):
    """
    检测可执行文件路径：系统 PATH 优先，项目 ffmpeg/ 目录兜底。
    name: 不含扩展名的程序名（如 'ffmpeg'、'ffprobe'）
    """
    # 1. 检查系统 PATH
    system_path = shutil.which(name)
    if system_path:
        return system_path

    # 2. 回退到项目内 ffmpeg/ 目录
    local_path = FFMPEG_DIR / f'{name}{_EXE_SUFFIX}'
    if local_path.exists():
        return str(local_path)

    # 3. 都找不到，返回原名（让 subprocess 报错时提示更清晰）
    return name + _EXE_SUFFIX


# 启动时检测并打印检测结果
FFMPEG_PATH = _find_executable('ffmpeg')
FFPROBE_PATH = _find_executable('ffprobe')
FFPLAY_PATH = _find_executable('ffplay')

if FFMPEG_PATH == f'ffmpeg{_EXE_SUFFIX}' and not shutil.which('ffmpeg'):
    print("[警告] 未找到 ffmpeg！请将 ffmpeg.exe 放入项目的 ffmpeg/ 文件夹，或安装到系统 PATH。")
else:
    _source = "系统 PATH" if shutil.which('ffmpeg') else f"项目目录 {FFMPEG_DIR}"
    print(f"[信息] ffmpeg 来源: {_source} -> {FFMPEG_PATH}")

# 字体路径（原始字符串，避免反斜杠转义）
FONT_BOLD = r"C:\Windows\Fonts\msyh.ttc"
FONT_REGULAR = r"C:\Windows\Fonts\msyh.ttc"

# 颜色（与前端保持一致）
BG_TOP = (30, 24, 24)
BG_BOTTOM = (21, 16, 16)

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')

# 任务存储
tasks = {}


# ===== LRC 歌词解析 =====

def parse_lrc(text):
    """解析 LRC 歌词，返回 [{time, text}] 列表"""
    time_regex = re.compile(r'\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]')
    lines = text.split('\n')
    lyrics = []

    for line in lines:
        matches = time_regex.findall(line)
        content = time_regex.sub('', line).strip()
        if not content:
            continue
        if matches:
            for m in matches:
                mins, secs = int(m[0]), int(m[1])
                ms = int(m[2].ljust(3, '0')) if m[2] else 0
                lyrics.append({'time': mins * 60 + secs + ms / 1000, 'text': content})
        else:
            lyrics.append({'time': -1, 'text': content})

    has_ts = any(l['time'] >= 0 for l in lyrics)
    if has_ts:
        return sorted([l for l in lyrics if l['time'] >= 0], key=lambda x: x['time'])
    return lyrics


def distribute_lyrics(lyrics, duration):
    """无时间戳歌词按时长均匀分配"""
    if not lyrics or duration <= 0:
        return lyrics
    if any(l['time'] >= 0 for l in lyrics):
        return sorted([l for l in lyrics if l['time'] >= 0], key=lambda x: x['time'])
    interval = duration / (len(lyrics) + 1)
    return [{'time': interval * (i + 1), 'text': l['text']} for i, l in enumerate(lyrics)]


def parse_filename(filename):
    """从文件名解析歌曲信息：歌曲名-歌手名-专辑名"""
    base = re.sub(r'\.[^.]+$', '', filename)
    parts = [s.strip() for s in base.split('-') if s.strip()]
    result = {'title': '', 'artist': '', 'album': ''}
    if len(parts) >= 3:
        result.update(title=parts[0], artist=parts[1], album=parts[2])
    elif len(parts) == 2:
        result.update(title=parts[0], artist=parts[1])
    elif len(parts) == 1:
        result['title'] = parts[0]
    return result


# ===== 音频时长获取 =====

def get_audio_duration(audio_path):
    """用 ffprobe 获取音频时长"""
    result = subprocess.run(
        [FFPROBE_PATH, '-v', 'quiet', '-print_format', 'json', '-show_format', str(audio_path)],
        capture_output=True, text=True, timeout=30
    )
    info = json.loads(result.stdout)
    return float(info['format']['duration'])


# ===== 帧位置预计算 =====

def precompute_positions(lyrics, duration, fps):
    """
    预计算所有帧的歌词滚动位置（与前端 lerp 逻辑一致）
    返回 [(current_time, display_pos, current_index), ...]
    """
    total_frames = int(duration * fps)
    positions = []
    display_pos = 0.0
    lerp_factor = 0.12

    for frame in range(total_frames):
        t = frame / fps
        # 查找当前歌词行
        new_index = 0
        for i in range(len(lyrics) - 1, -1, -1):
            if t >= lyrics[i]['time']:
                new_index = i
                break
        # 线性插值平滑滚动
        diff = new_index - display_pos
        display_pos += diff * lerp_factor
        if abs(diff) < 0.005:
            display_pos = float(new_index)
        positions.append((t, display_pos, new_index))

    return positions


# ===== 背景创建 =====

def create_background(width, height):
    """
    创建渐变背景（快速：小图 + resize）
    从 BG_TOP 到 BG_BOTTOM 的垂直渐变
    """
    # 创建 1x100 的渐变条，再 resize 到目标尺寸
    strip = Image.new('RGB', (1, 100))
    draw = ImageDraw.Draw(strip)
    for y in range(100):
        ratio = y / 99
        r = int(BG_TOP[0] * (1 - ratio) + BG_BOTTOM[0] * ratio)
        g = int(BG_TOP[1] * (1 - ratio) + BG_BOTTOM[1] * ratio)
        b = int(BG_TOP[2] * (1 - ratio) + BG_BOTTOM[2] * ratio)
        draw.point([(0, y)], fill=(r, g, b))
    return strip.resize((width, height), Image.BILINEAR).convert('RGBA')


# ===== 字体缓存（每个 worker 进程独立） =====

_font_cache = {}

def get_font(path, size):
    """获取字体对象，带缓存避免重复加载"""
    key = (path, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(path, size)
    return _font_cache[key]


# ===== 单帧渲染 =====

def render_frame(bg_img, width, height, lyrics, display_pos, scale):
    """
    渲染单帧歌词画面
    当前行白色加粗居中，其余行灰色随距离淡出
    """
    img = bg_img.copy()
    draw = ImageDraw.Draw(img, 'RGBA')

    line_height = int(48 * scale)
    visible_range = 5
    cx = width // 2
    cy = height // 2
    max_w = int(width * 0.88) - 40

    start_idx = max(0, int(display_pos - visible_range))
    end_idx = min(len(lyrics) - 1, int(display_pos + visible_range + 1))

    for i in range(start_idx, end_idx + 1):
        line = lyrics[i]
        offset = i - display_pos
        y = cy + int(offset * line_height)
        dist = abs(offset)
        alpha = max(0.0, 1.0 - dist / (visible_range + 0.5))
        is_current = dist < 0.5

        if is_current:
            font_size = int(26 * scale)
            font_path = FONT_BOLD
            color = (255, 255, 255, int(alpha * 255))
        else:
            font_size = max(12, int((20 - dist * 1.5) * scale))
            font_path = FONT_REGULAR
            gray = max(0, int(140 - dist * 25))
            color = (gray, max(0, gray - 5), max(0, gray - 10), int(alpha * 0.75 * 255))

        font_obj = get_font(font_path, font_size)

        # 超宽自动缩小字号
        tw = draw.textlength(line['text'], font=font_obj)
        while tw > max_w and font_size > 10:
            font_size -= 1
            font_obj = get_font(font_path, font_size)
            tw = draw.textlength(line['text'], font=font_obj)

        # 居中绘制
        bbox = draw.textbbox((0, 0), line['text'], font=font_obj)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        x = cx - tw // 2
        y_text = y - th // 2
        draw.text((x, y_text), line['text'], font=font_obj, fill=color)

    return img


# ===== 多进程 Worker =====

def render_chunk(args):
    """
    渲染一段帧范围（多进程 worker 函数）
    每个 worker 独立创建背景和字体缓存
    """
    chunk_id, start, end, width, height, lyrics, positions, scale, frame_dir = args

    # worker 内创建背景
    bg = create_background(width, height)

    for frame_idx in range(start, end):
        _, display_pos, _ = positions[frame_idx]
        img = render_frame(bg, width, height, lyrics, display_pos, scale)
        img.convert('RGB').save(
            os.path.join(frame_dir, f'frame_{frame_idx:06d}.jpg'),
            quality=90
        )

    return chunk_id


# ===== 后台渲染任务 =====

def render_task(task_id, audio_path, lrc_text, title, artist, album,
                width, height, fps):
    """后台渲染任务：解析 → 预计算 → 并行渲染 → FFmpeg 合成"""
    try:
        # --- 解析歌词 ---
        tasks[task_id]['status'] = 'parsing'
        tasks[task_id]['progress'] = 2
        lyrics = parse_lrc(lrc_text)

        # --- 获取音频时长 ---
        duration = get_audio_duration(audio_path)
        tasks[task_id]['progress'] = 5

        # --- 分配无时间戳歌词 ---
        lyrics = distribute_lyrics(lyrics, duration)
        if not lyrics:
            raise ValueError("歌词为空或格式无效")

        # --- 预计算帧位置 ---
        tasks[task_id]['status'] = 'computing'
        positions = precompute_positions(lyrics, duration, fps)
        total_frames = len(positions)
        tasks[task_id]['total_frames'] = total_frames
        tasks[task_id]['progress'] = 8

        # --- 并行渲染帧 ---
        tasks[task_id]['status'] = 'rendering'
        frame_dir = os.path.join(str(TEMP_DIR), f"{task_id}_frames")
        os.makedirs(frame_dir, exist_ok=True)

        scale = min(width, height) / 720
        num_workers = min(multiprocessing.cpu_count(), 8)
        chunk_size = max(1, total_frames // num_workers)

        chunks = []
        for i in range(num_workers):
            s = i * chunk_size
            e = min((i + 1) * chunk_size, total_frames)
            if s < e:
                chunks.append((i, s, e, width, height, lyrics, positions, scale, frame_dir))

        with ProcessPoolExecutor(max_workers=num_workers) as executor:
            futures = [executor.submit(render_chunk, c) for c in chunks]
            done = 0
            for f in futures:
                f.result()
                done += 1
                # 渲染占 80% 进度（8% ~ 88%）
                tasks[task_id]['progress'] = 8 + int(done / len(chunks) * 80)

        # --- FFmpeg 合成 ---
        tasks[task_id]['status'] = 'encoding'
        tasks[task_id]['progress'] = 88

        output_path = os.path.join(str(OUTPUT_DIR), f"{task_id}.mp4")
        cmd = [
            FFMPEG_PATH, '-y',
            '-framerate', str(fps),
            '-i', os.path.join(frame_dir, 'frame_%06d.jpg'),
            '-i', str(audio_path),
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '20',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',  # 索引前置，支持拖动
            '-shortest',
            output_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg 错误:\n{result.stderr[-500:]}")

        # --- 清理临时帧 ---
        shutil.rmtree(frame_dir, ignore_errors=True)

        # --- 完成 ---
        tasks[task_id]['status'] = 'done'
        tasks[task_id]['progress'] = 100
        tasks[task_id]['output_path'] = output_path
        tasks[task_id]['file_size'] = os.path.getsize(output_path)

    except Exception as e:
        tasks[task_id]['status'] = 'error'
        tasks[task_id]['error'] = str(e)
        import traceback
        traceback.print_exc()


# ===== API 路由 =====

@app.route('/')
def index():
    """返回前端页面"""
    return send_from_directory(str(BASE_DIR), 'index.html')


@app.route('/<path:path>')
def static_files(path):
    """静态文件服务"""
    return send_from_directory(str(BASE_DIR), path)


@app.route('/api/health')
def api_health():
    """健康检查接口，供前端检测后端是否在线"""
    return jsonify({'status': 'ok', 'version': '1.0'})


@app.route('/api/remux', methods=['POST'])
def api_remux():
    """
    修复浏览器录制的 MP4 音频编码。
    MediaRecorder 生成的 MP4 音频实际为 Opus，多数播放器不兼容。
    用 FFmpeg 将音频转为 AAC，视频流直接复制不重编码，秒级完成。
    """
    video_file = request.files.get('video')
    if not video_file:
        return jsonify({'error': '缺少视频文件'}), 400

    # 保存上传的视频
    remux_id = uuid.uuid4().hex[:8]
    input_ext = os.path.splitext(video_file.filename)[1] or '.mp4'
    input_path = os.path.join(str(TEMP_DIR), f"{remux_id}_input{input_ext}")
    output_path = os.path.join(str(OUTPUT_DIR), f"{remux_id}_fixed.mp4")
    video_file.save(input_path)

    # FFmpeg: 视频流复制，音频转 AAC，索引前置
    cmd = [
        FFMPEG_PATH, '-y',
        '-i', input_path,
        '-c:v', 'copy',          # 视频流直接复制，不重编码
        '-c:a', 'aac',           # 音频转 AAC
        '-b:a', '192k',
        '-movflags', '+faststart',  # 索引前置，支持拖动进度条
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    # 清理输入文件
    os.remove(input_path)

    if result.returncode != 0:
        return jsonify({'error': f'FFmpeg 错误: {result.stderr[-300:]}'}), 500

    return send_file(
        output_path,
        as_attachment=True,
        download_name=f"fixed.mp4"
    )


@app.route('/api/render', methods=['POST'])
def api_render():
    """提交渲染任务"""
    audio_file = request.files.get('audio')
    if not audio_file:
        return jsonify({'error': '缺少音频文件'}), 400

    lrc_text = request.form.get('lrc', '')
    title = request.form.get('title', '')
    artist = request.form.get('artist', '')
    album = request.form.get('album', '')
    width = int(request.form.get('width', 1080))
    height = int(request.form.get('height', 1920))
    fps = int(request.form.get('fps', 30))

    # 从文件名补全歌曲信息
    if not title or not artist:
        info = parse_filename(audio_file.filename)
        title = title or info['title']
        artist = artist or info['artist']
        album = album or info['album']

    task_id = uuid.uuid4().hex[:8]

    # 保存音频到临时文件
    audio_ext = os.path.splitext(audio_file.filename)[1] or '.mp3'
    audio_path = os.path.join(str(TEMP_DIR), f"{task_id}_audio{audio_ext}")
    audio_file.save(audio_path)

    # 初始化任务
    tasks[task_id] = {
        'status': 'pending',
        'progress': 0,
        'output_path': None,
        'filename': f"{title or '歌曲'}_歌词视频.mp4",
        'error': None,
        'total_frames': 0,
        'file_size': 0,
    }

    # 启动后台渲染线程
    thread = threading.Thread(
        target=render_task,
        args=(task_id, audio_path, lrc_text, title, artist, album, width, height, fps)
    )
    thread.daemon = True
    thread.start()

    return jsonify({'task_id': task_id})


@app.route('/api/status/<task_id>')
def api_status(task_id):
    """查询渲染进度"""
    task = tasks.get(task_id)
    if not task:
        return jsonify({'error': '任务不存在'}), 404
    return jsonify(task)


@app.route('/api/download/<task_id>')
def api_download(task_id):
    """下载生成的视频"""
    task = tasks.get(task_id)
    if not task or task['status'] != 'done':
        return jsonify({'error': '任务未完成'}), 400
    return send_file(
        task['output_path'],
        as_attachment=True,
        download_name=task['filename']
    )


if __name__ == '__main__':
    print("=" * 50)
    print("歌词视频生成器后端")
    print(f"  静态文件: {BASE_DIR}")
    print(f"  临时目录: {TEMP_DIR}")
    print(f"  输出目录: {OUTPUT_DIR}")
    print(f"  CPU 核心: {multiprocessing.cpu_count()}")
    print("  访问地址: http://localhost:5000")
    print("=" * 50)
    app.run(host='0.0.0.0', port=5000, debug=False)
