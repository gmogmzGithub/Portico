# Electron Performance Checklist

## Opaque windows toggle (macOS)
- Native sidebar vibrancy is the default so the OWUI rail can use macOS's
  blurred material while the chat canvas remains opaque.
- Set `PORTICO_OPAQUE_WINDOWS=1` to force the lower-compositor-cost opaque
  fallback when profiling drag or resize performance.
- The legacy explicit values `0`, `false`, `no`, and `off` continue to enable
  vibrancy.
- Example: `PORTICO_OPAQUE_WINDOWS=1 npm run start:dev`

## Webview profiling
- Open DevTools for the main window (`Cmd+Option+I`), then run:
  - `document.getElementById('chat-webview')?.openDevTools({ mode: 'detach' })`
  - `document.getElementById('artifact-webview')?.openDevTools({ mode: 'detach' })`
- Use the Performance panel to record while dragging; look for long compositor or raster tasks.

## Renderer/compositor checks
- DevTools > More tools > Rendering: enable FPS meter + paint flashing.
- Compare:
  - opaque vs transparent windows
  - artifact panel open vs closed

## OS-level signals
- Activity Monitor: watch `WindowServer`, GPU process, and the Electron app while dragging.
- Spikes in `WindowServer` usually indicate compositor pressure (often from transparent/vibrant windows).

## Optional diagnostics (do not ship)
- Launch with `--disable-gpu` to confirm GPU bottlenecks:
  - `npm run start:dev -- --disable-gpu`
