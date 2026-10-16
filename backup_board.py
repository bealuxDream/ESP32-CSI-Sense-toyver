"""Read and verify an 8 MiB ESP32-S3 backup in small retryable chunks."""
import argparse
import hashlib
from pathlib import Path

from esptool.targets.esp32s3 import ESP32S3ROM


def connect(port):
    rom = ESP32S3ROM(port, baud=115200)
    try:
        rom.connect()
        stub = rom.run_stub()
        stub.change_baud(460800)
        stub.flash_spi_attach(0)
        stub.flash_set_parameters(8 * 1024 * 1024)
        return stub
    except BaseException:
        rom._port.close()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise SystemExit('Backup already exists; choose a new output path.')
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix('.partial')
    esp = None
    digest = hashlib.sha256()
    try:
        with partial.open('wb') as stream:
            for offset in range(0, 8 * 1024 * 1024, 64 * 1024):
                for attempt in range(3):
                    try:
                        if esp is None:
                            esp = connect(args.port)
                        # esptool verifies each read against the device's MD5.
                        block = esp.read_flash(offset, 64 * 1024)
                        break
                    except Exception as error:
                        print(f'Retry {attempt + 1} at 0x{offset:x}: {error}', flush=True)
                        if esp is not None:
                            esp._port.close()
                            esp = None
                        if attempt == 2:
                            raise
                stream.write(block)
                digest.update(block)
                if offset % (512 * 1024) == 0:
                    print(f'Verified {offset + len(block)} / 8388608 bytes', flush=True)
        partial.rename(output)
        print(f'Backup complete: {output} SHA256={digest.hexdigest()}', flush=True)
    finally:
        if esp is not None:
            try:
                esp.hard_reset()
            finally:
                esp._port.close()


if __name__ == '__main__':
    main()
