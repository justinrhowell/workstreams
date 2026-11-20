# ws on Windows (WSL)

ws runs on Windows through WSL 2. Native Windows (PowerShell or cmd) is not supported: hook commands, the `~/.local/bin` link and path checks all assume a POSIX system. On native Windows every `ws` command, and the MCP server, stops with a message pointing here, and `ws hook …` exits quietly so a session is never broken.

The rule that makes WSL work: **ws, Node, your data and your agent CLIs all live inside WSL.** A Claude Code, Codex or Gemini CLI installed on the Windows side keeps its settings under `C:\Users\<you>\`, so it never sees the hooks ws installs in WSL.

## Setup

1. Install WSL with a Linux distribution (Ubuntu is the default), from PowerShell:

   ```powershell
   wsl --install
   ```

   Then open the distribution's shell. Everything below runs there.

2. Install Node 22 or newer **inside WSL**, for example with [nvm](https://github.com/nvm-sh/nvm):

   ```bash
   nvm install 22
   command -v node      # must NOT start with /mnt/c/
   ```

   If `command -v node` points into `/mnt/c/…`, WSL is finding the Windows `node.exe` through your Windows PATH. Hooks can't run ws with it. Install Node in WSL and make sure it comes first on `PATH`.

3. Install the agent CLIs you use **inside WSL** (for example `npm install -g @anthropic-ai/claude-code`, `@openai/codex` or `@google/gemini-cli`), and start your sessions from the WSL shell.

4. Clone ws into your WSL home, not under `/mnt/c`, and run setup:

   ```bash
   cd ~ && git clone https://github.com/justinrhowell/workstreams.git && cd workstreams
   npm --prefix ws ci
   node ws/bin/ws.mjs setup
   ```

   Setup warns if it finds a Windows `node`, or ws or its data folder on a Windows drive. Files under `/mnt/c` are slow from Linux and lose Linux file permissions, so keep both inside WSL.

5. Make sure `~/.local/bin` is on your `PATH`. Ubuntu's `~/.profile` adds it when the folder exists, so open a new shell after setup. Then `ws ls` should work.

Your project folders can stay where they are. A workstream's `--cwd` is the path as WSL sees it (for example `/mnt/c/Users/you/code/site`), because that is the folder your agent sessions report.

## The board

```bash
npm ci        # once, from the repo root
ws board
```

WSL 2 forwards `localhost` to Windows, so `http://127.0.0.1:3311` opens in your Windows browser. ws opens it with `wslview` (from the `wslu` package) if installed, otherwise with `explorer.exe`.

The background service (`ws board --install`) is the Linux one: a systemd user unit managed with `systemctl --user`. WSL needs systemd enabled for it, which is the default on current installs. Check that `/etc/wsl.conf` has:

```ini
[boot]
systemd=true
```

## Clipboard

`ws prompt` copies with `wl-copy`, `xclip` or `xsel` when one is set up, and otherwise with Windows' `clip.exe`, so the prompt lands on the Windows clipboard.

## Native Windows

Native support would mean PowerShell or cmd hook commands, a replacement for the `~/.local/bin` symlink, and Windows path handling throughout. It's tracked in the issue tracker. CI runs a Windows job that checks native Windows is refused cleanly, as described above.
