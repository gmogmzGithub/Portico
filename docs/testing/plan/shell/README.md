# B — Electron shell: windows, menus & shortcuts

Materially altered in PORTICO-67 (zoom + tab shortcuts) and PORTICO-68 (window-close model). Exercise on the actual packaged build, not just `npm start`, because menu accelerators and `before-input-event` interactions differ.

- Up: [`docs/testing/README.md`](../../README.md).
- Source: [`electron-app/src/services/main.js`](../../../../electron-app/src/services/main.js), [`electron-app/src/services/bootstrap.js`](../../../../electron-app/src/services/bootstrap.js).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|    34 |     12 |   22 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                           | Type    | Coverage | Status | Last run | File |
|-------|--------------------------------------------------------------------|---------|----------|--------|----------|------|
| B-01  | App menu has File / Edit / View / Window / Help with native roles  | Shell   | Partial  | Pass   | 2026-04-28 | [window-and-menu.md](window-and-menu.md) |
| B-02  | Window menu lists the full Tab+Window block                        | Shell   | Auto     | Pass   | 2026-04-28 | [window-and-menu.md](window-and-menu.md) |
| B-03  | About dialog renders correct version/build/channel                 | Shell   | Manual   | NotRun | -        | [window-and-menu.md](window-and-menu.md) |
| B-04  | Reinstall / Install Specific Build menu items                      | Shell   | Partial  | Pass   | 2026-04-28 | [window-and-menu.md](window-and-menu.md) |
| B-05  | Bundled icons in About / dock / task switcher                      | Shell   | Manual   | NotRun | -        | [window-and-menu.md](window-and-menu.md) |
| B-10  | `Cmd+N` / `Cmd+T` new chat tab                                     | Shell   | Partial  | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-11  | `Cmd+Shift+N` new detached chat window                             | Shell   | Partial  | NotRun | -        | [shortcuts.md](shortcuts.md) |
| B-12  | `Cmd+W` on main shell with closable chat tab                       | Shell   | Auto     | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-13  | `Cmd+W` on a detached chat window                                  | Shell   | Auto     | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-14  | `Cmd+W` on utility/dialog window does NOT intercept                | Shell   | Auto     | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-15  | `Cmd+Shift+W` closes entire main shell window                      | Shell   | Auto     | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-16  | `Cmd+Shift+W` on detached / dialog                                 | Shell   | Partial  | NotRun | -        | [shortcuts.md](shortcuts.md) |
| B-17  | `Cmd+Q` quits entire app                                           | Shell   | Manual   | NotRun | -          | [shortcuts.md](shortcuts.md) |
| B-18  | `Cmd+1` … `Cmd+9` switch directly to tab N                         | Shell   | Manual   | NotRun | -        | [shortcuts.md](shortcuts.md) |
| B-19  | `Cmd+Opt+←` / `Cmd+Opt+→` previous/next tab                        | Shell   | Manual   | NotRun | -        | [shortcuts.md](shortcuts.md) |
| B-20  | `Cmd+F` opens local find; `Shift+Cmd+F` opens global search        | Search  | Auto     | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-21  | `Cmd+G` / `Shift+Cmd+G` find-next/prev                             | Search  | Partial  | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-22  | `Cmd+=` / `Cmd+-` / `Cmd+0` UI scale                               | Theme   | Auto     | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-23  | Edit-menu shortcuts in input fields                                | Shell   | Auto     | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-24  | `Cmd+W` is NOT forwarded to renderer for utility windows           | Shell   | Auto     | Pass   | 2026-04-28 | [shortcuts.md](shortcuts.md) |
| B-30  | Open up to 20 chat tabs                                            | Shell   | Partial  | NotRun | -        | [tabs.md](tabs.md) |
| B-31  | LRU suspension >12 tabs                                            | Shell   | Manual   | NotRun | -        | [tabs.md](tabs.md) |
| B-32  | Tab title updates for fresh chats and follows renames              | Shell   | Auto     | Pass   | 2026-04-28 | [tabs.md](tabs.md) |
| B-33  | Hover tooltip shows full title                                     | Shell   | Auto     | Pass   | 2026-04-28 | [tabs.md](tabs.md) |
| B-34  | Right-click tab context menu                                       | Shell   | Partial  | NotRun | -        | [tabs.md](tabs.md) |
| B-35  | Drag tab out → detaches into window, session preserved             | Shell   | Auto     | Pass   | 2026-04-28 | [tabs.md](tabs.md) |
| B-36  | Return detached window with its redock button                      | Shell   | Auto     | Pass   | 2026-04-28 | [tabs.md](tabs.md) |
| B-37  | Scroll-to-message after tab switch                                 | Search  | Partial  | NotRun | -        | [tabs.md](tabs.md) |
| B-38  | Closing last user tab returns to control plane                     | Shell   | Manual   | NotRun | -        | [tabs.md](tabs.md) |
| B-39  | Detached window header reflects current chat title                 | Shell   | Auto     | Pass   | 2026-04-28 | [tabs.md](tabs.md) |
| B-40  | Tab strip CSS uses tokens, not hex                                 | Theme   | Auto     | Pass   | 2026-04-28 | [tabs.md](tabs.md) |
| B-50  | Close find overlay → focus returns to OWUI view                    | Search  | Auto     | Pass   | 2026-04-28 | [focus-handoff.md](focus-handoff.md) |
| B-51  | Switching tabs hands off focus                                     | Shell   | Auto     | Pass   | 2026-04-28 | [focus-handoff.md](focus-handoff.md) |
| B-52  | OAuth/guided-setup focus does not flicker the main window          | Auth    | Partial  | Pass   | 2026-04-28 | [focus-handoff.md](focus-handoff.md) |

## Files in this folder

- [window-and-menu.md](window-and-menu.md) — App and Window menu structure (B-01 .. B-05).
- [shortcuts.md](shortcuts.md) — Keyboard shortcuts (B-10 .. B-24).
- [tabs.md](tabs.md) — Tab strip behavior (B-30 .. B-40).
- [focus-handoff.md](focus-handoff.md) — Focus transitions across windows/overlays (B-50 .. B-52).
