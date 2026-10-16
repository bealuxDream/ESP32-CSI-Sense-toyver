"""Capture actual serial frames for a smoke check and browser replay."""
import argparse
from collections import deque
from datetime import datetime, timezone
import json
from pathlib import Path
import time

import serial


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--seconds', type=float, default=20)
    parser.add_argument('--output', default='artifacts/hardware-capture.json')
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise SystemExit('Capture exists; choose another output path.')
    output.parent.mkdir(parents=True, exist_ok=True)
    frames, messages, pending = [], deque(maxlen=2000), b''
    device = serial.Serial(port=None, baudrate=115200, timeout=0.2)
    device.dtr = False
    device.rts = False
    device.port = args.port
    device.open()
    started = time.monotonic()
    try:
        while time.monotonic() - started < args.seconds:
            pending += device.read(1024)
            while b'\n' in pending:
                raw, pending = pending.split(b'\n', 1)
                line = raw.rstrip(b'\r').decode('utf-8', errors='replace')
                if line.startswith(('CSI,', 'NET,')):
                    frames.append({'t': round((time.monotonic() - started) * 1000), 'line': line})
                elif line:
                    messages.append(line)
            if len(pending) > 8192:
                pending = b''
    finally:
        device.close()
    output.write_text(json.dumps({
        'version': 2, 'source': 'hardware',
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'note': 'Actual COM port capture; no generated or simulated frames.',
        'frames': frames,
    }, ensure_ascii=False), encoding='utf-8')
    output.with_suffix('.log').write_text('\n'.join(messages), encoding='utf-8')
    counts = {prefix: sum(f['line'].startswith(prefix + ',') for f in frames) for prefix in ('CSI', 'NET')}
    print(json.dumps({'port': args.port, 'seconds': args.seconds, 'frames': counts, 'output': str(output)}))
    for message in list(messages)[-15:]:
        print(message)
    if not frames:
        raise SystemExit('No CSI/NET frames received; inspect the saved log.')


if __name__ == '__main__':
    main()
