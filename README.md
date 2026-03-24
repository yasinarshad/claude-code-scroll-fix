# claude-code-scroll-fix

Fix Claude Code's viewport jumping + add native scrollback. Single JS file, no dependencies, no PTY proxy.

## The Problem

Claude Code has two terminal problems that affect every terminal emulator (Ghostty, iTerm2, Terminal.app, Kitty, WezTerm, etc.):

1. **Viewport jumping** — when Claude streams output, your viewport yanks to the bottom. You can't read earlier content while the agent is working. (651+ reactions on [#826](https://github.com/anthropics/claude-code/issues/826))

2. **No scrollback** — you can't scroll up to see previous messages. Ink (React for terminals) erases and redraws in place — content never enters your terminal's scrollback buffer.

**Why it happens:** Claude Code uses [Ink](https://github.com/vadimdemedes/ink), which redraws the entire screen 30 times per second. Each redraw emits cursor-up escape sequences (`\x1b[{N}A`) that exceed your viewport height. Your terminal **must** follow these cursor movements — that's how VT100 has worked since 1978.

## The Fix

A single JavaScript file that runs **inside** Claude Code's Node.js process. It does two things:

**1. Stops viewport jumping** — intercepts `process.stdout.write` and clamps cursor-up sequences so the total upward movement per write never exceeds your viewport height.

**2. Adds native scrollback** — captures rendered frames, strips ANSI escape sequences, diffs them to find new content, and after 500ms of stability emits clean text into your terminal's native scrollback buffer. Scroll up with your trackpad to see previous messages.

## Quick Start

### 1. Download the fix

```bash
curl -o ~/.config/scroll-fix.cjs https://raw.githubusercontent.com/yasinarshad/claude-code-scroll-fix/main/scroll-fix.cjs
```

### 2. Load it when running Claude Code

```bash
NODE_OPTIONS="--require ~/.config/scroll-fix.cjs" claude
```

Or add it to your shell profile (`~/.zshrc` / `~/.bashrc`):

```bash
alias claude='NODE_OPTIONS="--require $HOME/.config/scroll-fix.cjs" claude'
```

That's it. No compile step, no dependencies, no Rust toolchain.

## Terminal-Specific Setup

### Ghostty

If your Ghostty config launches Claude Code directly, add `NODE_OPTIONS` to the command:

```
command = /bin/bash -c 'cd ~/your/project && NODE_OPTIONS="--require /path/to/scroll-fix.cjs" claude; exec bash'
```

### iTerm2 / Terminal.app / Kitty / WezTerm

Use the shell alias approach:

```bash
# Add to ~/.zshrc or ~/.bashrc
alias claude='NODE_OPTIONS="--require $HOME/.config/scroll-fix.cjs" claude'
```

### tmux

Works out of the box. The fix runs inside Node.js, so tmux doesn't interfere.

## Bonus: Ctrl+6 Freeze Toggle

Press **Ctrl+6** to freeze Claude Code's output while you read. Press again to resume. While frozen:
- The tab title shows `[FROZEN - Ctrl+6 to resume]`
- All output is buffered and replayed when you unfreeze

> **macOS note:** Some terminals require **Ctrl+Shift+6** (i.e., Ctrl+^) instead of Ctrl+6.

## How It Works

### Viewport Fix

```
Without scroll-fix:
  Ink renderer → \x1b[500A (cursor up 500 lines) → Terminal follows cursor → YANK

With scroll-fix:
  Ink renderer → \x1b[500A → scroll-fix clamps to \x1b[24A → Terminal stays put
```

Intercepts every `process.stdout.write` call and applies a per-write "cursor-up budget" equal to `process.stdout.rows` (your viewport height). Any cursor-up sequences beyond that budget are stripped.

### Scrollback Injection

```
Without scroll-fix:
  Ink redraws in place → old content erased → scrollback buffer empty

With scroll-fix:
  Frame captured → ANSI stripped → diffed against previous frame → new content
  emitted as clean text → pushed above viewport with padding → persists in
  native scrollback buffer
```

After each response settles (500ms debounce), the fix emits clean text into the terminal's scrollback buffer with enough padding to push it above Ink's reach. Position-aware deduplication prevents the same content from appearing twice. The dedup map is capped at 50K entries to prevent memory growth in long sessions. On process exit, the final frame is flushed to scrollback.

### Why not use a PTY proxy?

Tools like [claude-chill](https://github.com/davidbeesley/claude-chill) solve the jumping by sitting between your terminal and Claude Code as an external proxy. The tradeoff: your terminal loses native trackpad scrolling because the proxy intercepts the output stream.

This fix runs inside Node.js — your terminal is still directly connected to the process, so trackpad scrolling and all terminal features work normally.

## What This Doesn't Fix

- **Flickering during fast output** — Reduced but not eliminated. The fix clamps cursor movement but Ink still redraws at 30 FPS.

## Known Issues

- The `NODE_OPTIONS="--require ..."` flag is inherited by child Node.js processes. The fix includes guards (`isTTY` check, `.unref()`) to prevent interference, but if you encounter hanging `npm install` or similar, this could be the cause. Remove the env var for those commands.
- Scrollback injection is v1 — some visual artifacts may appear in the scrollback between clean content and Ink's raw output.

## Credits

- **[@cruzlauroiii](https://github.com/cruzlauroiii)** — Original viewport fix approach ([PR #35683](https://github.com/anthropics/claude-code/pull/35683) on anthropics/claude-code)
- **[@yasinarshad](https://github.com/yasinarshad)** — Bug fixes (isTTY guard, `.unref()`, memory cap), scrollback injection, and documentation

## Related Issues

| Issue | Description |
|-------|------------|
| [anthropics/claude-code#826](https://github.com/anthropics/claude-code/issues/826) | Terminal flashing/flickering (651+ reactions) |
| [anthropics/claude-code#35683](https://github.com/anthropics/claude-code/pull/35683) | Original scroll-fix PR (unmerged) |
| [anthropics/claude-code#28077](https://github.com/anthropics/claude-code/issues/28077) | Scrollback history limitation |
| [microsoft/terminal#14774](https://github.com/microsoft/terminal/issues/14774) | Windows Terminal cursor-up issue |

## License

MIT
