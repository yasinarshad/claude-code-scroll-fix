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
  var _emittedLines = {};       // Hash → true for lines already in scrollback
  var _stableTimer = null;      // Debounce timer for settled content
  var _currentFrameRaw = "";    // Accumulates raw output for current frame
  var _hasRedraw = false;       // Did we see cursor-up in this write?
  var _frameCount = 0;          // Frame counter for dedup
  var _lastEmitFrame = 0;       // Last frame we emitted scrollback for

  /* Simple string hash for dedup */
  function _hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return h;
  }

  /* Strip ANSI escape sequences to get plain text */
  function _stripAnsi(s) {
    return s
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")   // CSI sequences
      .replace(/\x1b\][^\x07]*\x07/g, "")       // OSC sequences
      .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "")  // Private mode sequences
      .replace(/\x1b[()][AB012]/g, "")           // Character set sequences
      .replace(/\r/g, "");                        // Carriage returns
  }

  /* Emit settled content into terminal scrollback */
  function _emitScrollback() {
    if (_prevFrameLines.length === 0) return;
    if (_frameCount <= _lastEmitFrame + 2) return; // Need at least 2 stable frames

    var newLines = [];
    for (var i = 0; i < _prevFrameLines.length; i++) {
      var line = _prevFrameLines[i];
      if (!line || !line.trim()) continue; // Skip empty lines
      var h = _hash(line);
      if (!_emittedLines[h]) {
        newLines.push(line);
        _emittedLines[h] = true;
      }
    }

    if (newLines.length > 0) {
      /* Emit clean text + separator. These lines appear at the current cursor
       * position. When Ink next redraws with a clamped cursor-up, these lines
       * will be above its reach and persist in terminal scrollback. */
      var scrollbackText = "\n" + newLines.join("\n") + "\n\x1b[90m" + "─".repeat(40) + "\x1b[0m\n";
      _ow(scrollbackText);
      _lastEmitFrame = _frameCount;
    }
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
        _frameCount++;
        var cleanText = _stripAnsi(_currentFrameRaw);
        var lines = cleanText.split("\n").filter(function (l) {
          return l.trim().length > 0;
        });

        if (lines.length > 0) {
          _prevFrameLines = lines;
        }

        _currentFrameRaw = "";

        /* Debounce: emit scrollback after 800ms of stability */
        if (_stableTimer) {
          clearTimeout(_stableTimer);
        }
        _stableTimer = setTimeout(function () {
          _emitScrollback();
        }, 800);
        _stableTimer.unref();
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
