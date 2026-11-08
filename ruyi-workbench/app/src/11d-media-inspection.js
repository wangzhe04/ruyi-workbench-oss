// Local media diagnostics and parse-only source checks. No desktop or network I/O.
const MediaInspection = (() => {
  const io = require('fs/promises');
  const nodePath = require('path');
  const nodeOs = require('os');
  const childProcess = require('child_process');
  const cache = new Map();
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const bounded = (value, fallback, low, high) => value == null || !Number.isFinite(Number(value)) ? fallback : Math.max(low, Math.min(high, Number(value)));
  const VIDEO_FORMATS = new Map([
    ['.mp4', 'mov'], ['.m4v', 'mov'], ['.mov', 'mov'],
    ['.mkv', 'matroska'], ['.webm', 'matroska'], ['.avi', 'avi'],
  ]);
  const VIDEO_FAILURES = Object.freeze({
    video_format_unsupported: 'Use a local MP4, M4V, MOV, MKV, WebM or AVI video file.',
    video_options_invalid: 'Use startSeconds 0–86400, frameCount 1–4, and intervalSeconds 0.25–30.',
    video_source_invalid: 'Use a nonempty local video file of at most 50 MiB.',
    video_decoder_unavailable: 'The verified offline video decoder is unavailable.',
    video_decode_failed: 'The local decoder could not read this video track.',
    video_no_frames: 'No video frame was decoded in the requested time window.',
    video_timestamp_invalid: 'The decoder could not establish a usable video timeline.',
    video_limits_exceeded: 'The video exceeds the local frame decoding limits.',
  });
  const videoFailure = code => ({ ok: false, code, error: VIDEO_FAILURES[code] });
  const isVideoPath = file => VIDEO_FORMATS.has(nodePath.extname(file).toLowerCase());

  function videoTargets({ startSeconds = 0, frameCount = 3, intervalSeconds = 1 }) {
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 86400
      || !Number.isInteger(frameCount) || frameCount < 1 || frameCount > 4
      || !Number.isFinite(intervalSeconds) || intervalSeconds < 0.25 || intervalSeconds > 30) return null;
    const start = Math.round(startSeconds * 1000), step = Math.round(intervalSeconds * 1000);
    return Array.from({ length: frameCount }, (_, index) => start + index * step);
  }

  function isVideoFramePng(data) {
    if (typeof data !== 'string' || data.length > Math.ceil(4 * 1024 * 1024 / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
    const bytes = Buffer.from(data, 'base64');
    try {
      if (bytes.length < 33 || bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== data
        || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13
        || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      return width >= 1 && width <= 960 && height >= 1 && height <= 960;
    } finally { bytes.fill(0); }
  }

  // The caller supplies an authorized, bounded snapshot. Only its bytes and the
  // selected demuxer reach the verified worker, never the source path.
  async function videoFrames(file, args = {}, signal, bytes) {
    const format = VIDEO_FORMATS.get(nodePath.extname(file).toLowerCase());
    if (!format) return videoFailure('video_format_unsupported');
    const targets = videoTargets(args);
    if (!targets) return videoFailure('video_options_invalid');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 50 * 1024 * 1024) return videoFailure('video_source_invalid');
    signal?.throwIfAborted();
    if (typeof MediaImageHooks === 'undefined' || typeof MediaImageHooks.runLocalMediaHelper !== 'function') {
      return videoFailure('video_decoder_unavailable');
    }
    const whitelist = format === 'matroska' ? 'matroska,webm' : format;
    const captureOptions = `protocol_whitelist;ruyi-no-external-io|format_whitelist;${whitelist}|input_format;${format}|max_pixels;8294400`
      + (format === 'mov' ? '|enable_drefs;0|use_absolute_path;0' : '');
    const result = await MediaImageHooks.runLocalMediaHelper('native-video-read.py', [format, JSON.stringify(targets)], bytes, {
      signal, timeoutMs: 30000, maxBytes: 18 * 1024 * 1024,
      env: { OPENCV_FFMPEG_CAPTURE_OPTIONS: captureOptions, OPENCV_LOG_LEVEL: 'SILENT' },
    });
    signal?.throwIfAborted();
    if (result?.ok === false && Object.hasOwn(VIDEO_FAILURES, result.code)) return videoFailure(result.code);
    if (result?.ok !== true || !Array.isArray(result.frames) || !result.frames.length
      || result.frames.length > targets.length || !result.frames.every((frame, index) => frame?.requestedMs === targets[index]
        && Number.isSafeInteger(frame.timestampMs) && frame.timestampMs >= frame.requestedMs
        && frame.timestampMs <= frame.requestedMs + 5000 && (index === 0 || frame.timestampMs > result.frames[index - 1].timestampMs)
        && isVideoFramePng(frame.png))) return videoFailure('video_decode_failed');
    const requestedSeconds = targets.map(value => value / 1000);
    const sampledSeconds = result.frames.map(frame => frame.timestampMs / 1000);
    const missedSeconds = requestedSeconds.slice(sampledSeconds.length);
    const coverage = { requestedSeconds, sampledSeconds, missedSeconds, fullVideo: false,
      audioIncluded: false, subtitlesIncluded: false, containerMetadataIncluded: false };
    const content = `Video stills at decoded timestamps ${sampledSeconds.join(', ')} seconds. Only the returned frames were sampled.`
      + (missedSeconds.length ? ` No frame was returned for requested times ${missedSeconds.join(', ')} seconds.` : '')
      + ' Audio, subtitle tracks and container metadata were excluded.';
    return { ok: true, mode: 'video', content, coverage,
      images: result.frames.map((frame, index) => ({ name: `frame-${index + 1}.png`, mimeType: 'image/png', data: frame.png })) };
  }

  function run(command, argv, options = {}) {
    return new Promise(resolve => {
      let stdout = '', stderr = '', finished = false, timedOut = false;
      let child;
      const done = (code, error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ ok: code === 0 && !timedOut, code, timedOut, stdout, stderr, ...(error ? { error: String(error.message || error) } : {}) });
      };
      const timer = setTimeout(() => { timedOut = true; if (child) child.kill(); }, options.timeoutMs || 5000);
      try {
        child = childProcess.spawn(command, argv, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.on('data', b => { stdout = (stdout + b.toString()).slice(-262144); });
        child.stderr.on('data', b => {
          const fragment = b.toString();
          stderr = (stderr + fragment).slice(-32768);
          if (options.onStderr) options.onStderr(fragment);
        });
        child.once('error', error => done(null, error));
        child.once('close', code => done(code));
        child.stdin.on('error', () => {});
        child.stdin.end(options.input || '');
      } catch (error) { done(null, error); }
    });
  }

  async function candidates(names) {
    const found = [];
    for (const name of names.filter(Boolean)) {
      if (nodePath.isAbsolute(name)) { if ((await io.stat(name).catch(() => null))?.isFile()) found.push(name); continue; }
      for (const dir of String(process.env.PATH || '').split(nodePath.delimiter).filter(Boolean)) {
        for (const suffix of process.platform === 'win32' ? ['.exe', ''] : ['']) {
          const candidate = nodePath.join(dir, name + suffix);
          if ((await io.stat(candidate).catch(() => null))?.isFile()) found.push(candidate);
        }
      }
    }
    return [...new Set(found)];
  }

  async function locate(kind, refresh = false) {
    const key = [kind, process.env.PATH, process.env.RUYI_BUNDLED_PYTHON, process.env.VIRTUAL_ENV, process.env.IMAGEIO_FFMPEG_EXE, process.env.FFMPEG_BINARY].join('|');
    const previous = cache.get(key);
    if (!refresh && previous && Date.now() - previous.at < 30000 && (!previous.value.path || await io.stat(previous.value.path).catch(() => null))) return previous.value;
    let names = [];
    if (kind === 'python') names = [process.env.RUYI_BUNDLED_PYTHON, process.env.VIRTUAL_ENV && nodePath.join(process.env.VIRTUAL_ENV, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), 'python3', 'python'];
    if (kind === 'node') names = [!process.pkg && process.execPath, 'node'];
    if (kind === 'ffmpeg') names = [process.env.IMAGEIO_FFMPEG_EXE, process.env.FFMPEG_BINARY, 'ffmpeg'];
    if (kind === 'ffprobe') names = ['ffprobe'];
    if (kind === 'chrome') names = ['chrome', 'chromium', 'chromium-browser', 'msedge',
      ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap(dir => [nodePath.join(dir, 'Google/Chrome/Application/chrome.exe'), nodePath.join(dir, 'Microsoft/Edge/Application/msedge.exe')]),
      ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : [])];
    let executablePaths = await candidates(names);
    if (kind === 'ffmpeg' && !executablePaths.length) {
      const python = await locate('python', refresh);
      if (python.available) {
        // Locate the wheel's bundled binary without asking imageio to download anything.
        const result = await run(python.path, ['-I', '-c', 'import importlib.util,pathlib,json; s=importlib.util.find_spec("imageio_ffmpeg"); print(json.dumps([str(p) for p in (pathlib.Path(s.origin).parent/"binaries").glob("ffmpeg-*") if p.is_file()] if s else []))']);
        try { executablePaths = await candidates(JSON.parse(result.stdout.trim())); } catch { /* absent wheel */ }
      }
    }
    if (kind === 'ffprobe' && !executablePaths.length) {
      const ffmpeg = await locate('ffmpeg', refresh);
      if (ffmpeg.available) executablePaths = await candidates([nodePath.join(nodePath.dirname(ffmpeg.path), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')]);
    }
    let value = { available: false, path: null, version: null };
    for (const candidate of executablePaths.slice(0, 8)) {
      // Chrome --version can launch a visible browser on Windows; existence is reported honestly.
      if (kind === 'chrome' && process.platform === 'win32') { value = { available: true, path: candidate, version: null, verification: 'file_exists' }; break; }
      const r = await run(candidate, [kind === 'ffmpeg' || kind === 'ffprobe' ? '-version' : '--version']);
      if (r.ok) { value = { available: true, path: candidate, version: (r.stdout || r.stderr).split(/\r?\n/)[0].slice(0, 180), verification: 'version_command' }; break; }
    }
    if (!value.available) value.hint = kind === 'ffprobe'
      ? 'Install the full FFmpeg distribution and add its bin directory to PATH; imageio-ffmpeg commonly bundles ffmpeg only. audio_inspect can still analyze audio using ffmpeg.'
      : kind === 'ffmpeg' ? 'Install FFmpeg and add its bin directory to PATH, or set IMAGEIO_FFMPEG_EXE to its executable. An installed imageio-ffmpeg wheel is also detected.'
        : `Install ${kind === 'chrome' ? 'Chrome/Chromium/Edge' : kind} and make its executable available on PATH.`;
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function dependencies(refresh) {
    const result = {}, capabilities = {};
    for (const kind of ['ffmpeg', 'ffprobe', 'chrome', 'python', 'node']) result[kind] = await locate(kind, refresh);
    // 图像遮盖/派生管线(13bc 的原生处理器)能不能真的起来 —— 这决定 file_read 的视觉分支与
    // 渲染件能不能经保护交付。这里不自己猜:问 13 层注册的 hook;没有 hook(或它抛非预期错)就
    // 老实说 not_loaded,绝不写 available:true。
    try {
      const probe = MediaImageHooks && typeof MediaImageHooks.availability === 'function' ? await MediaImageHooks.availability() : null;
      // 渲染/遮盖管线的处理器不是「可执行依赖」(没有 hint/path 那套形状),所以放在 capabilities 下,
      // 不混进 dependencies —— 那个表有既有的逐项形状契约(media-harness.test.js 会逐项断言)。
      capabilities.imageProcessor = probe && typeof probe.available === 'boolean' ? probe : { available: false, path: null, reason: 'not_loaded' };
    } catch { capabilities.imageProcessor = { available: false, path: null, reason: 'not_loaded' }; }
    return { ok: true, dependencies: result, capabilities, installsPerformed: false };
  }

  async function checkSyntax(file, content) {
    if (Buffer.byteLength(content, "utf8") > 1024 * 1024) return { ok: false, code: "source_too_large", error: "Syntax checks accept at most 1MB of source.", executed: false };
    const extension = nodePath.extname(file).toLowerCase();
    if (extension === '.json') {
      try { JSON.parse(content.replace(/^\uFEFF/, '')); return { ok: true, valid: true, language: 'json', executed: false }; }
      catch (error) { return { ok: false, valid: false, code: 'syntax_error', language: 'json', error: error.message, executed: false }; }
    }
    const kind = extension === '.py' ? 'python' : /\.(?:js|mjs|cjs)$/.test(extension) ? 'node' : '';
    if (!kind) return { ok: false, code: 'unsupported_syntax', error: 'Parse-only checks support .py, .js, .mjs, .cjs and .json.', executed: false };
    const executable = await locate(kind);
    if (!executable.available) return { ok: false, code: 'dependency_missing', dependency: kind, hint: executable.hint, executed: false };
    let result;
    if (kind === 'python') result = await run(executable.path, ['-I', '-c', 'import ast,sys; ast.parse(sys.stdin.buffer.read().decode("utf-8-sig"), filename=sys.argv[1])', file], { input: content, timeoutMs: 10000 });
    else {
      const directory = await io.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'ruyi-syntax-'));
      try {
        // Node determines .js semantics from the nearest package.json, not the temp directory.
        let candidateExtension = extension;
        if (extension === '.js') {
          // Dependency .js files default to CommonJS even when their package omits type.
          if (nodePath.resolve(file).split(nodePath.sep).includes('node_modules')) candidateExtension = '.cjs';
          let current = nodePath.dirname(nodePath.resolve(file));
          while (nodePath.basename(current) !== 'node_modules') {
            let packageText;
            try { packageText = await io.readFile(nodePath.join(current, 'package.json'), 'utf8'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (packageText !== undefined) {
              const packageType = JSON.parse(packageText.replace(/^\uFEFF/, '')).type;
              if (packageType === 'module') candidateExtension = '.mjs';
              else if (packageType === 'commonjs') candidateExtension = '.cjs';
              break;
            }
            const parent = nodePath.dirname(current);
            if (parent === current) break;
            current = parent;
          }
        }
        const candidate = nodePath.join(directory, 'candidate' + candidateExtension);
        await io.writeFile(candidate, content, 'utf8');
        result = await run(executable.path, ['--check', candidate], { timeoutMs: 10000 });
      } finally { await io.rm(directory, { recursive: true, force: true }); }
    }
    return { ok: result.ok, valid: result.ok, language: kind === 'node' ? 'javascript' : 'python', executed: false,
      ...(result.ok ? {} : { code: result.timedOut ? 'syntax_check_timeout' : 'syntax_error', error: (result.stderr || result.error || result.stdout).slice(-6000) }) };
  }

  function audioCollector(start, interval, limit) {
    let pending = '', frame = null;
    const windows = new Map();
    const channels = new Map();
    let integratedLufs = null, loudnessRangeLu = null, measuredEnd = 0;
    const commit = () => {
      if (!frame) return;
      const time = start + frame.time;
      measuredEnd = Math.max(measuredEnd, frame.time + 0.1);
      const index = Math.floor(frame.time / interval);
      if (!windows.has(index) && windows.size < limit) windows.set(index, { startSeconds: start + index * interval, endSeconds: time + 0.1, peakDbfs: null, rmsDbfs: null, momentaryLufs: null, shortTermLufs: null });
      const window = windows.get(index);
      const maximum = (a, b) => a == null ? b : b == null ? a : Math.max(a, b);
      for (const [key, raw] of Object.entries(frame.values)) {
        const value = finite(raw);
        if (key === 'r128.I') integratedLufs = value;
        if (key === 'r128.LRA') loudnessRangeLu = value;
        if (window) {
          window.endSeconds = time + 0.1;
          if (key === 'astats.Overall.Peak_level') window.peakDbfs = maximum(window.peakDbfs, value);
          if (key === 'astats.Overall.RMS_level') window.rmsDbfs = maximum(window.rmsDbfs, value);
          if (key === 'r128.M') window.momentaryLufs = value;
          if (key === 'r128.S') window.shortTermLufs = value;
        }
        const match = /^astats\.(\d+)\.(Peak_level|RMS_level)$/.exec(key);
        if (match) {
          const channel = Number(match[1]);
          if (!channels.has(channel)) channels.set(channel, { channel, peakDbfs: null, maxWindowRmsDbfs: null });
          const row = channels.get(channel);
          const field = match[2] === 'Peak_level' ? 'peakDbfs' : 'maxWindowRmsDbfs';
          row[field] = maximum(row[field], value);
        }
      }
    };
    const line = fragment => {
      const timestamp = /\bpts_time:([\d.e+-]+)/.exec(fragment);
      if (timestamp) { commit(); frame = { time: Number(timestamp[1]), values: {} }; }
      const match = /lavfi\.((?:r128|astats)\.[\w.]+)=([^\s]+)/.exec(fragment);
      if (match && frame) frame.values[match[1]] = match[2];
    };
    return {
      feed(fragment) { pending += fragment; const lines = pending.split(/\r?\n/); pending = lines.pop().slice(-8192); for (const entry of lines) line(entry); },
      finish() {
        line(pending); commit();
        const curve = [...windows.values()];
        return { measuredSeconds: measuredEnd, integratedLufs, loudnessRangeLu, channels: [...channels.values()], curve,
          nearClipWindows: curve.filter(w => w.peakDbfs != null && w.peakDbfs >= -0.1).map(w => ({ startSeconds: w.startSeconds, endSeconds: w.endSeconds, peakDbfs: w.peakDbfs })) };
      },
    };
  }

  async function inspectAudio(file, args) {
    if (!/\.(wav|mp3|m4a|mp4|aac|flac|ogg|opus|webm|mkv|aif|aiff|wma)$/i.test(file)) return { ok: false, code: 'unsupported_media', error: 'Use a local audio/video container; playlists and external media references are not accepted.' };
    const ffmpeg = await locate('ffmpeg');
    if (!ffmpeg.available) return { ok: false, code: 'dependency_missing', dependency: 'ffmpeg', hint: ffmpeg.hint };
    const start = bounded(args.startSeconds, 0, 0, 86400);
    const duration = bounded(args.durationSeconds, 120, 0.1, 1800);
    const interval = Math.max(bounded(args.windowSeconds, 1, 0.1, 60), duration / 600);
    const stream = Math.floor(bounded(args.stream, 0, 0, 63));
    const collector = audioCollector(start, interval, 601);
    const result = await run(ffmpeg.path, ['-nostdin', '-hide_banner', '-nostats', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,mov,matroska,webm,ogg,flac,aac,aiff,asf', '-ss', String(start), '-i', file,
      '-t', String(duration), '-map', `0:a:${stream}`, '-vn', '-sn', '-dn', '-af', 'ebur128=metadata=1:peak=true,astats=metadata=1:reset=1:measure_perchannel=Peak_level+RMS_level:measure_overall=Peak_level+RMS_level,ametadata=mode=print', '-f', 'null', '-'],
    { timeoutMs: 60000, onStderr: fragment => collector.feed(fragment) });
    if (!result.ok) return { ok: false, code: result.timedOut ? 'media_timeout' : 'audio_decode_failed', error: (result.error || result.stderr).slice(-4000), hint: 'Check the audio stream index and media format; try a shorter durationSeconds window.' };
    const analysis = collector.finish();
    if (!analysis.curve.length) return { ok: false, code: 'audio_measurement_missing', error: 'FFmpeg returned no audio measurement frames.' };
    return { ok: true, path: file, stream, startSeconds: start, requestedSeconds: duration, windowSeconds: interval, ...analysis,
      nextStartSeconds: analysis.measuredSeconds >= duration - 0.1 ? start + duration : null,
      measurement: 'EBU R128 loudness; sample peak dBFS; per-window maximum RMS dBFS',
      nearClipThresholdDbfs: -0.1, listeningPerformed: false,
      note: 'Objective signal analysis, not listening. Near-clip windows flag sample peaks at or above -0.1 dBFS; they do not prove audible distortion. Use file_read on visual evidence and user playback for subjective review.' };
  }
  return { dependencies, locate, checkSyntax, inspectAudio, audioCollector, isVideoPath, videoFrames };
})();
