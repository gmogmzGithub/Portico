# macOS App Header Hit-Testing (March 2026)

**Layers affected:** Electron Shell (window chrome, native views), Chat UI (renderer header markup).

**Status:** Mitigated; underlying root cause not fully closed.

## Symptom

On macOS, header controls in the Electron shell were sometimes only interactable from the bottom edge of their hit-box; the top portion behaved as a window-drag / titlebar region instead. The failure was tab-sensitive: the **Control Plane** tab (pure renderer DOM under the shared header) was reliably worse than **Chat** (OWUI native-host path under the same header). Affected controls included `Chat`, `Control Plane`, `Copy`, theme toggle, the bug / service-drawer button, and the MCP-servers badge hover area. A related modal dead-zone in the same top band was reported earlier in the same period.

## Root cause (best understanding)

Electron / macOS drag-and-hit testing appears to be rectangle-based and brittle when draggable and non-draggable regions share the same visual band. When the shared header tried to host its own drag strip alongside interactive controls, the system would reliably misclassify the top of the controls as titlebar.

The Control-Plane-only behaviour is consistent with renderer geometry, not different header code: Chat sits on the OWUI native-host path while Control Plane is pure renderer DOM directly under the shared header. The shared markup is identical; the content under it changes the geometry enough that Control Plane exposes the bug more aggressively.

A secondary issue — hidden OWUI / artifact native views remaining at full visible bounds — was responsible for the modal-control dead zones in the same top band.

## What shipped

- Main window uses `BrowserWindow` with `titleBarStyle: 'hiddenInset'`; `titleBarOverlay` is no longer enabled for the main window. Traffic-light positioning is manual.
- A dedicated `window-drag-strip` element sits **above** the header. The header itself is fully `-webkit-app-region: no-drag`. This was the only configuration in which the user reported clean header interaction across both tabs.
- Hidden native views collapse to `0x0` bounds rather than just becoming invisible. This eliminated the modal top-band dead zones.

## Known limitation

The dedicated-strip configuration introduces a visible blank gap above the header on macOS. Reducing the drag-strip height without rethinking the top-shell layout reliably reintroduces broken hit areas, so any further iteration should redesign the top shell so the drag strip is visually integrated, rather than re-embedding the drag region inside the same box as interactive controls.

## Files involved

- `electron-app/src/services/windows.js` — main-window titlebar mode and traffic-light positioning.
- `electron-app/src/renderer/views/index.html` — `window-drag-strip` placement above the shared header.
- `electron-app/src/styles.css` — `no-drag` rules on header and modal subtrees.
- `electron-app/src/services/owui-views.js`, `electron-app/src/services/artifact-views.js` — hidden-view bounds collapsing.
