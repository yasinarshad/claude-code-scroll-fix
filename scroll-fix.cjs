/**
 * scroll-fix.cjs — Fixes viewport jumping + adds scrollback for Claude Code
 *
 * TWO FIXES IN ONE FILE:
 *
 * 1. VIEWPORT JUMPING (from @cruzlauroiii's PR #35683):
 *    Clamps cursor-up sequences so total upward movement per write
 *    never exceeds viewport height. Stops the "yank to bottom".
 *
 * 2. SCROLLBACK INJECTION (new):
 *    Captures rendered frames, diffs them, and emits new settled content
 *    as plain text into the terminal's native scrollback buffer.
 *    When Ink erases and redraws, the emitted content is already above
 *    its reach — it persists in scrollback for trackpad scrolling.
 *
 * BONUS — Ctrl+6 freeze toggle:
 *    Press Ctrl+6 to freeze output. Press again to resume.
 *
 * Source: https://github.com/yasinarshad/claude-code-scroll-fix
 */

"use strict";

(function () {
  var _ow = process.stdout.write.bind(process.stdout);
  var _frozen = false;
  var _buf = [];

  /* — Scrollback state ——————————————————————————————————————————————— */
  var _prevFrameLines = [];     // Previous frame's clean text lines
  var _emittedContent = {};     // "lineNum:hash" → true (position-aware dedup)
  var _emittedCount = 0;        // Track hash map size for memory management
  var _currentFrameRaw = "";    // Accumulates raw output for current frame
  var _hasRedraw = false;       // Did we see cursor-up in this write?
  var _lastContentHash = 0;     // Hash of previous frame's stripped content
  var _sameHashCount = 0;       // How many consecutive frames had the same hash
  var _SETTLE_THRESHOLD = 2;    // Emit after content is identical for N consecutive frames
  /* Note: _currentFrameRaw serves as the "last frame" buffer for exit flush */

  /* Maximum entries in _emittedContent before pruning (prevents unbounded growth) */
  var _EMIT_MAP_MAX = 50000;

  /* Position-aware hash: same text at different positions = different entry */
  function _posHash(idx, s) {
    var h = idx;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return idx + ":" + h;
  }

  /* Strip ANSI escape sequences to get plain text */
  function _stripAnsi(s) {
    return s
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")   // CSI sequences (SGR, cursor, erase, etc.)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")  // OSC sequences (BEL or ST terminated)
      .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "")  // Private mode sequences (?25l, ?1049h, etc.)
      .replace(/\x1b[()][AB012]/g, "")           // Character set sequences
      .replace(/\x1b[78]/g, "")                   // DEC cursor save (\x1b7) and restore (\x1b8)
      .replace(/\r/g, "");                        // Carriage returns
  }

  /* Emit settled content into terminal scrollback */
  function _emitScrollback() {
    if (_prevFrameLines.length === 0) return;

    /* Prune the hash map if it grows too large (memory safety) */
    if (_emittedCount > _EMIT_MAP_MAX) {
      _emittedContent = {};
      _emittedCount = 0;
    }

    var newLines = [];
    for (var i = 0; i < _prevFrameLines.length; i++) {
      var line = _prevFrameLines[i];
      var key = _posHash(i, line);
      if (!_emittedContent[key]) {
        newLines.push(line);
        _emittedContent[key] = true;
        _emittedCount++;
      }
    }

    if (newLines.length > 0) {
      /* Emit clean text + separator. We push enough newlines to scroll the
       * emitted content above the viewport so Ink's clamped cursor-up can't
       * reach it. The padding ensures the content survives the next redraw. */
      var maxUp = process.stdout.rows || 24;
      var scrollbackText = "\n" + newLines.join("\n") + "\n\x1b[90m" + "─".repeat(40) + "\x1b[0m\n";

      /* Always pad by full viewport height to push content above Ink's reach.
       * Ink's cursor-up is clamped to maxUp, so padding by maxUp guarantees
       * the emitted text is unreachable regardless of content length. */
      var padding = maxUp;
      scrollbackText += "\n".repeat(padding);
      /* Move cursor back up to where Ink expects it */
      scrollbackText += "\x1b[" + padding + "A";

      _ow(scrollbackText);
    }
  }

  /* Flush final frame on process exit (synchronous) */
  if (process.stdout.isTTY) {
    process.on("exit", function () {
      if (_currentFrameRaw.length > 0) {
        var cleanText = _stripAnsi(_currentFrameRaw);
        var lines = cleanText.split("\n");
        if (lines.length > 0) {
          _prevFrameLines = lines;
        }
      }
      _emitScrollback();
    });
  }

  /* — Ctrl+6 freeze toggle (\x1e) ———————————————————————————————————— */
  if (process.stdout.isTTY) {
    var _t = setTimeout(function () {
      try {
        process.stdin.on("data", function (d) {
          if (d.toString().indexOf("\x1e") !== -1) {
            _frozen = !_frozen;
            if (_frozen) {
              _ow("\x1b]0;Claude Code [FROZEN - Ctrl+6 to resume]\x07");
            } else {
              if (_buf.length > 0) {
                var a = "";
                for (var i = 0; i < _buf.length; i++) a += _buf[i];
                _buf = [];
                _ow(a);
              }
              _ow("\x1b]0;Claude Code\x07");
            }
          }
        });
        process.stdin.unref();
      } catch (e) {}
    }, 2000);
    _t.unref();
  }

  /* — stdout.write interceptor ————————————————————————————————————————— */
  process.stdout.write = function (d, e, c) {
    if (typeof e === "function") {
      c = e;
      e = void 0;
    }
    var s =
      typeof d === "string"
        ? d
        : Buffer.isBuffer(d)
          ? d.toString("utf-8")
          : String(d);
    var maxUp = process.stdout.rows || 24;

    /* Detect redraw: cursor-up sequences signal start of new frame */
    _hasRedraw = false;

    /* Clamp cursor-up per write call */
    var upBudget = maxUp;
    s = s.replace(/\x1b\[(\d*)A/g, function (m, p) {
      var n = parseInt(p) || 1;
      _hasRedraw = true;
      if (upBudget <= 0) return "";
      var allowed = n > upBudget ? upBudget : n;
      upBudget -= allowed;
      return "\x1b[" + allowed + "A";
    });

    /* Track frames for scrollback */
    if (process.stdout.isTTY) {
      if (_hasRedraw) {
        /* New frame starting — process the previous frame */
        var cleanText = _stripAnsi(_currentFrameRaw);
        /* Preserve blank lines for code block formatting */
        var lines = cleanText.split("\n");

        /* Filter out frames that are purely empty (only whitespace/cursor movement) */
        var hasContent = false;
        for (var li = 0; li < lines.length; li++) {
          if (lines[li].trim().length > 0) { hasContent = true; break; }
        }

        if (hasContent) {
          _prevFrameLines = lines;

          /* Content-hash settlement: compute a hash of the stripped frame.
           * When the same hash appears N times in a row, content has settled
           * and we emit. This replaces the time-based debounce which broke
           * when continuous UI redraws (spinners, status line) reset the timer. */
          var contentHash = 0;
          for (var ci = 0; ci < cleanText.length; ci++) {
            contentHash = ((contentHash << 5) - contentHash + cleanText.charCodeAt(ci)) | 0;
          }

          if (contentHash === _lastContentHash) {
            _sameHashCount++;
            if (_sameHashCount >= _SETTLE_THRESHOLD) {
              _emitScrollback();
              _sameHashCount = 0;
            }
          } else {
            _lastContentHash = contentHash;
            _sameHashCount = 1;
          }
        }

        _currentFrameRaw = "";
      }

      /* Accumulate current frame content */
      _currentFrameRaw += s;
    }

    /* Freeze: buffer ALL output when frozen */
    if (_frozen) {
      _buf.push(s);
      if (c) c();
      return true;
    }

    if (typeof d === "string") return _ow(s, e, c);
    return _ow(Buffer.from(s, "utf-8"), e, c);
  };
})();
