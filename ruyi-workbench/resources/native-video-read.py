"""Decode bounded stills from a local video snapshot supplied on stdin."""

import base64
import io
import json
import math
import os
import sys


MAX_SOURCE_BYTES = 50 * 1024 * 1024
MAX_PIXELS = 8_294_400
MAX_SIDE = 960
MAX_GRABS = 12_000
MAX_DRIFT_MS = 5_000


class VideoRefusal(Exception):
    pass


def worker_options(demuxer):
    formats = {'mov': 'mov', 'matroska': 'matroska,webm', 'avi': 'avi'}
    whitelist = formats.get(demuxer)
    if whitelist is None:
        raise VideoRefusal('video_format_unsupported')
    options = (f'protocol_whitelist;ruyi-no-external-io|format_whitelist;{whitelist}'
               f'|input_format;{demuxer}|max_pixels;{MAX_PIXELS}')
    if demuxer == 'mov':
        options += '|enable_drefs;0|use_absolute_path;0'
    return options


def read_targets(raw):
    targets = json.loads(raw)
    if (not isinstance(targets, list) or not 1 <= len(targets) <= 4
            or any(type(value) is not int for value in targets)
            or not 0 <= targets[0] <= 86_400_000
            or any(not 250 <= right - left <= 30_000 for left, right in zip(targets, targets[1:]))):
        raise VideoRefusal('video_options_invalid')
    return targets


def frame_png(cv2, frame):
    height, width = frame.shape[:2]
    if not 1 <= width * height <= MAX_PIXELS:
        raise VideoRefusal('video_limits_exceeded')
    if max(width, height) > MAX_SIDE:
        scale = MAX_SIDE / max(width, height)
        frame = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))),
                           interpolation=cv2.INTER_AREA)
    ok, png = cv2.imencode('.png', frame)
    if not ok or png.size > 4 * 1024 * 1024:
        raise VideoRefusal('video_decode_failed')
    return base64.b64encode(png).decode('ascii')


def timestamp_ms(cv2, capture):
    value = capture.get(cv2.CAP_PROP_POS_MSEC)
    if not math.isfinite(value) or value < 0:
        raise VideoRefusal('video_timestamp_invalid')
    return round(value)


def sample_frames(cv2, video, targets):
    params = [cv2.CAP_PROP_N_THREADS, 1,
              cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000,
              cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000]
    # Custom seekable AVIO supplies the sole input. The allowlisted demuxer has
    # no filename and all secondary protocols are denied at open.
    with cv2.VideoCapture(io.BytesIO(video), cv2.CAP_FFMPEG, params) as capture:
        if not capture.isOpened() or capture.getBackendName() != 'FFMPEG':
            raise VideoRefusal('video_decode_failed')
        width = capture.get(cv2.CAP_PROP_FRAME_WIDTH)
        height = capture.get(cv2.CAP_PROP_FRAME_HEIGHT)
        if not 1 <= width * height <= MAX_PIXELS:
            raise VideoRefusal('video_limits_exceeded')
        frames = []
        previous = None
        distinct = 0
        if targets[0]:
            if not capture.grab():
                raise VideoRefusal('video_no_frames')
            previous = timestamp_ms(cv2, capture)
            distinct = 1
            if not capture.set(cv2.CAP_PROP_POS_MSEC, targets[0]):
                raise VideoRefusal('video_timestamp_invalid')

        for _ in range(MAX_GRABS):
            if not capture.grab():
                break
            timestamp = timestamp_ms(cv2, capture)
            if previous is not None and timestamp < previous:
                raise VideoRefusal('video_timestamp_invalid')
            if timestamp == previous:
                continue
            previous = timestamp
            distinct += 1
            # Require a timeline, even if only one still was requested. An
            # attached cover image can produce one decoded frame at time zero.
            if len(frames) == len(targets):
                if distinct >= 2:
                    break
                continue
            requested = targets[len(frames)]
            if timestamp < requested:
                continue
            if timestamp > requested + MAX_DRIFT_MS:
                break
            ok, frame = capture.retrieve()
            if not ok or frame is None:
                raise VideoRefusal('video_decode_failed')
            frames.append({'requestedMs': requested, 'timestampMs': timestamp, 'png': frame_png(cv2, frame)})
            if len(frames) == len(targets) and distinct >= 2:
                break
        else:
            raise VideoRefusal('video_limits_exceeded')

        if not frames or distinct < 2:
            raise VideoRefusal('video_no_frames')
        return frames


def main():
    try:
        demuxer, raw_targets = sys.argv[1:]
        if os.environ.get('OPENCV_FFMPEG_CAPTURE_OPTIONS') != worker_options(demuxer):
            raise VideoRefusal('video_decoder_unavailable')
        targets = read_targets(raw_targets)
        source = sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1)
        if not 1 <= len(source) <= MAX_SOURCE_BYTES:
            raise VideoRefusal('video_source_invalid')
        import cv2
        result = {'ok': True, 'frames': sample_frames(cv2, source, targets)}
    except VideoRefusal as error:
        result = {'ok': False, 'code': str(error)}
    except (ImportError, OSError):
        result = {'ok': False, 'code': 'video_decoder_unavailable'}
    except Exception:
        result = {'ok': False, 'code': 'video_decode_failed'}
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()
