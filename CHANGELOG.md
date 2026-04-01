# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] — 2026-04-01

### Fixed

- **Scrollback injection not firing on Claude Code v2.1.85+** — The 500ms time-based debounce never settled because newer Claude Code versions have continuous UI redraws (status line, companion, spinners) that reset the timer every frame. Replaced with content-hash settlement detection: scrollback emits when 2 consecutive frames have identical content, regardless of how often Ink redraws. ([#826](https://github.com/anthropics/claude-code/issues/826))

- **Scrollback overwritten on long responses** — Padding calculation used `viewport_height - content_lines`, which went to zero for responses longer than the viewport. Ink's next redraw would overwrite the injected scrollback. Now always pads by full viewport height so emitted content is unreachable by Ink's clamped cursor-up.

### Technical Details

**Before (broken):**
```
Frame arrives → reset 500ms timer → timer never expires → scrollback never emitted
```

**After (fixed):**
```
Frame arrives → hash content → same as last frame? → count++ → threshold hit → emit scrollback
```

The content hash uses djb2 over the ANSI-stripped frame text. Two consecutive identical hashes (settle threshold = 2) trigger emission. Continuous UI redraws with the same content settle immediately; content changes during streaming reset the counter.

## [1.0.0] — 2026-03-24

### Added

- **Viewport jumping fix** — Intercepts `process.stdout.write` and clamps cursor-up sequences (`\x1b[{N}A`) so total upward movement per write never exceeds viewport height. Based on [@cruzlauroiii](https://github.com/cruzlauroiii)'s approach from [PR #35683](https://github.com/anthropics/claude-code/pull/35683).

- **Scrollback injection** — Captures rendered frames, strips ANSI escape sequences, diffs against previous frame using position-aware hashing, and emits clean text into the terminal's native scrollback buffer. Padding pushes content above Ink's clamped cursor-up reach.

- **Ctrl+6 freeze toggle** — Press Ctrl+6 to pause Claude Code's output while reading. Press again to resume. Tab title shows `[FROZEN - Ctrl+6 to resume]`. All output buffered and replayed on unfreeze.

- **Bug fixes from debug agent** (65 tests, 6 bugs fixed):
  - OSC ST-terminator not stripped (Ghostty uses ST `\x1b\\` not BEL `\x07`)
  - DEC cursor save/restore (`\x1b7`/`\x1b8`) not stripped
  - Scrollback overwritten by next Ink redraw (added viewport-height padding)
  - Unbounded `_emittedContent` hash map growth (added 50K entry cap with pruning)
  - Final frame lost on exit (added `process.on("exit")` synchronous flush)
  - Empty frames accepted (added content-presence scan)

- **isTTY guard** — Prevents interference with child Node.js processes (npm install, etc.)
- **`.unref()` on timers and stdin** — Prevents the fix from keeping the process alive
- **Memory cap** — `_emittedContent` hash map pruned at 50K entries
