---
name: esp32-csi-sense-architecture-insight
description: Locate the minimal files for ESP32-S3 CSI firmware, browser visualization, Windows WLAN monitoring, build scripts and public packaging changes.
---

# ESP32 CSI Sense architecture

## Route in 30 seconds

1. Read `README.md` for the public startup and flashing contract.
2. Choose a scenario in [file-router.md](references/file-router.md).
3. Read only the owning files before editing.

## Core boundaries

- Keep Wi-Fi callbacks, LLTF copying and NET counters in `firmware/main/main.c`.
- Keep parsing, normalization, calibration and rolling metrics in `viewer/core.js`.
- Keep serial input, replay and charts in `viewer/app.js`; own UI structure in `viewer/index.html`.
- Keep Windows WLAN / source-bound gateway probes in `viewer/pc_wifi.py`, its browser polling in `viewer/pc_wifi.js`, and HTTP routing in `viewer/serve.py`.
- Keep build staging in `build_firmware.ps1`; keep launcher discovery in `start_viewer.ps1`.

## Architectural invariants

- Preserve explicit hardware, replay and simulation labels. Never generate fallback hardware data.
- Preserve graph history and calibration across isolated other-format CSI packets.
- Use probe outcome counters for loss, never CSI sequence gaps.
- Keep computer WLAN metrics distinct from ESP32 CSI; expose no arbitrary probe destination.
- Bind the HTTP service to loopback and the Windows probe to its WLAN source address.
- Keep credentials, Flash backups, generated firmware and private captures out of Git. Publish only example configs.
- Preserve originals on the board; flashing is a separate user-authorized operation from software verification.

## Edit workflow

1. Select the owning layer; update user-facing documentation if its behavior changes.
2. Run `node tests/test_core.cjs` for CSI / NET logic and `python tests/test_pc_wifi.py` for local monitoring.
3. Run `node --check` on changed browser scripts. Verify visible UI for chart/layout changes.
4. For firmware changes, use an installed ESP-IDF and a test SSID for compilation; do not reflash merely to publish docs.
5. Inspect the Git index before publication; never use force-add on ignored local files.

## Search shortcuts

```text
rg -n 'csi_rx|ping_success|output_network_stats' firmware/main/main.c
rg -n 'class Signal|pendingFormat|calibration|class Network' viewer/core.js
rg -n 'changeView|ingest|drawHeat|netPlot' viewer/app.js
rg -n 'WindowsWifi|ipv4_route|ping_gateway|WifiMonitor' viewer/pc_wifi.py
rg -n 'local.json|CompileCheck|IDF_TARGET' build_firmware.ps1 .gitignore
```
