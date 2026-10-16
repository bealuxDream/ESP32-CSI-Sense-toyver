# File router

| Scenario | Minimal files | Reason |
| --- | --- | --- |
| CLI / command syntax | `viewer/serve.py`, `start_viewer.cmd`, `start_viewer.ps1` | Own ports, browser launch and Python discovery. |
| Download / install / version selection | `README.md`, `runtime.example.json`, `SOURCES.md` | Direct users to official Python / ESP-IDF; there is no built-in downloader or automatic version resolver. |
| Environment / path setup | `build_firmware.ps1`, `runtime.example.json`, `start_viewer.ps1` | Own tool paths and ASCII staging; no shim or version-switching subsystem exists. |
| Data / directory layout | `.gitignore`, `build_firmware.ps1`, `capture_hardware.py`, `viewer/app.js` | Separate public sources from local configs, generated artifacts and recordings. |
| One-click launch / build orchestration | `start_viewer.cmd`, `start_viewer.ps1`, `build_firmware.ps1`, `README.md` | Keep instructions aligned with executable scripts. |
| Dependencies | `firmware/main/CMakeLists.txt`, `firmware/sdkconfig.defaults`, `README.md` | Browser uses no package manager; viewer uses Python stdlib. Optional capture / backup helpers use pyserial / esptool from ESP-IDF. |
| CSI parsing / calibration / format stability | `viewer/core.js`, `tests/test_core.cjs`, `viewer/app.js` | Core owns numerical logic; app owns messages and display. |
| Firmware acquisition | `firmware/main/main.c`, `firmware/main/Kconfig.projbuild`, `firmware/sdkconfig.defaults` | Own LLTF data layout, rates, Wi-Fi settings and NET emission. |
| Computer WLAN monitoring | `viewer/pc_wifi.py`, `viewer/pc_wifi.js`, `viewer/serve.py`, `tests/test_pc_wifi.py` | Keep native readings, source-bound probes, polling and API access rules together. |
| Error diagnostics / user guidance | `README.md`, `viewer/app.js`, `viewer/pc_wifi.js`, `build_firmware.ps1` | Update messages at the layer that knows the failure cause. |
| Public tutorial / images | `README.md`, `docs/images/`, `SOURCES.md`, `VALIDATION.md` | Keep illustrative figures separate from measured evidence. |

## Security and publication hotspots

- Check `viewer/core.js` for strict CSI / NET parsing and recording limits.
- Check `viewer/serve.py` for loopback-only binding, API host/origin checks and exclusive Windows port binding.
- Check `viewer/pc_wifi.py` for WLAN adapter matching, fixed gateway destinations, source binding and native memory cleanup.
- Check `build_firmware.ps1` for configuration paths, temporary copies, credentials and separate compile/flash modes.
- Review `.gitignore` and `git diff --cached` before pushing. Exclude local SSIDs/passwords, full Flash backups, firmware binaries and private sample data.

## Validation entry points

```text
node --check viewer/core.js
node --check viewer/app.js
node --check viewer/pc_wifi.js
node tests/test_core.cjs
python tests/test_pc_wifi.py
```

Compile firmware with ESP-IDF v5.5.1 (v5.4.2 initial baseline). Use `build_firmware.ps1 -CompileCheck` on a configured Windows machine; it does not flash hardware.
