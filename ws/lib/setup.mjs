// `ws setup` / `ws setup --uninstall`: wire ws into Claude Code, Codex and Gemini CLI, or take it out.
// Creates the data folder, links the CLI onto PATH, merges the SessionStart/SessionEnd
// hooks into each tool's settings, and registers the MCP server. Idempotent: re-running
// reconciles ws's own entries (hooks, MCP, CLI link) and leaves everything else alone.
import { spawnSync } from "node:child_process"
import { promises as fs, existsSync, realpathSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import * as store from "./store.mjs"
import { claudeDir, codexDir, geminiDir } from "./paths.mjs"
import { platformProblem, isWsl, onWindowsDrive } from "./platform.mjs"

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const BIN = path.join(PKG, "bin", "ws.mjs")
export const MCP = path.join(PKG, "mcp", "server.mjs")

// Claude and Codex count seconds; Gemini counts milliseconds. Codex and Gemini wait on
// SessionEnd before exiting, so their end hooks stay short; heavy work (the summarizer)
// is always detached.
const TIMEOUTS = { claude: { start: 10, end: 20 }, codex: { start: 10, end: 3 }, gemini: { start: 10_000, end: 5_000 } }
export const TOOLS = ["claude", "codex", "gemini"]
const EVENTS = { start: "SessionStart", end: "SessionEnd" }

export const settingsFile = (tool, env = process.env) =>
  tool === "claude" ? path.join(claudeDir(env), "settings.json")
    : tool === "gemini" ? path.join(geminiDir(env), "settings.json")
      : path.join(codexDir(env), "hooks.json")

// POSIX shell quoting for hook commands (all three tools run them through sh/bash on macOS and Linux).
const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)

const defaultRootFor = (home) => path.join(home, ".local", "share", "ws")
// Hooks and MCP servers don't read your shell profile, so a non-default data folder
// (from WS_ROOT or XDG_DATA_HOME) is pinned into each command.
export const needsPin = (root, home = os.homedir()) => root !== defaultRootFor(home)

export function hookCommand(tool, event, { wsPath, root, home } = {}) {
  const pin = needsPin(root, home) ? `WS_ROOT=${q(root)} ` : ""
  return `${pin}${q(wsPath)} hook ${tool} ${event}`
}

// A hook entry is ws's only if the WHOLE command is a ws hook call, optionally with a
// WS_ROOT=… prefix. A ws call inside a larger command belongs to the user.
// A shell word: quoted or escaped pieces glued together ('/a'\''b' is one word), with no
// unquoted separators or redirections (; & | < > ( ) ` and newlines).
const WORD = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s'"\\;&|<>()\`])+`
const unquote = (w) => w.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g, (_, sq, dq, esc) => sq ?? (dq !== undefined ? dq.replace(/\\(.)/g, "$1") : esc))
export function classifyHook(cmd, tool, event) {
  const c = String(cmd || "").trim()
  // Command substitution or a second line means more than a ws call, quoted or not.
  const extra = /[\n\r`]|\$\(/.test(c)
  const m = c.match(new RegExp(`^(?:WS_ROOT=${WORD}\\s+)?(${WORD})\\s+hook\\s+${tool}\\s+${event}$`))
  if (m && !extra && /(^|\/)ws(\.mjs)?$/.test(unquote(m[1]).replace(/^\$HOME|^~/, ""))) return "ours"
  if (new RegExp(`\\bws(\\.mjs)?['"]?\\s+hook\\s+${tool}\\s+${event}\\b`).test(c)) return "embedded"
  return "other"
}

// Does an existing ws hook already run the same ws, with the same data folder? Spelling
// doesn't matter ("$HOME/.local/bin/ws", "~/.local/bin/ws", the link or its target), so
// re-running setup leaves a working hand-written hook alone (Codex would otherwise ask
// to trust it again).
const realOr = (p) => { try { return realpathSync(p) } catch { return path.resolve(p) } }
export function sameHook(cmd, tool, event, { wsPath, root, home }) {
  const m = String(cmd || "").trim().match(new RegExp(`^(?:WS_ROOT=(${WORD})\\s+)?(${WORD})\\s+hook\\s+${tool}\\s+${event}$`))
  if (!m) return false
  const exp = (w) => unquote(w).replace(/^(\$HOME|\$\{HOME\}|~)(?=\/)/, home)
  const pinned = m[1] ? realOr(exp(m[1])) : null
  const wanted = needsPin(root, home) ? realOr(root) : null
  return pinned === wanted && realOr(exp(m[2])) === realOr(wsPath)
}

// Pure: returns { settings, changes, notes } with ws's hook entries added, updated or
// de-duplicated. Hooks that aren't purely ws's are never changed.
export function mergeHooks(settings, tool, opts) {
  const out = structuredClone(settings || {})
  out.hooks ||= {}
  const changes = []
  const notes = []
  for (const [event, name] of Object.entries(EVENTS)) {
    const command = hookCommand(tool, event, opts)
    const timeout = TIMEOUTS[tool][event]
    const groups = (out.hooks[name] ||= [])
    const ours = []
    let embedded = false
    for (const g of groups) for (const h of g.hooks || []) {
      if (h.type !== "command") continue
      const kind = classifyHook(h.command, tool, event)
      if (kind === "ours") ours.push({ g, h })
      if (kind === "embedded") embedded = true
    }
    if (!ours.length && embedded) {
      notes.push(`${name}: a custom hook already calls \`ws hook ${tool} ${event}\`; left as is`)
      continue
    }
    if (!ours.length) {
      groups.push({ hooks: [{ type: "command", command, timeout }] })
      changes.push(`added ${name}`)
      continue
    }
    // Every ws hook is brought up to date. Copies under the same matcher are merged; a
    // copy under another matcher runs for other sessions, so it's kept (and updated).
    const seen = new Set()
    let updated = false
    for (const { g, h } of ours) {
      const key = g.matcher ?? null
      if (seen.has(key)) {
        g.hooks = g.hooks.filter((x) => x !== h)
        changes.push(`removed duplicate ${name}`)
        continue
      }
      seen.add(key)
      const same = h.command === command || sameHook(h.command, tool, event, { ...opts, home: opts.home || os.homedir() })
      if (!same) { h.command = command; updated = true }
      if (h.timeout !== timeout) { h.timeout = timeout; updated = true }
      if (g.matcher) notes.push(`${name}: a ws hook sits under matcher "${g.matcher}", so it only runs for those sessions`)
    }
    if (updated) changes.push(`updated ${name}`)
    out.hooks[name] = groups.filter((g) => (g.hooks || []).length)
  }
  return { settings: out, changes, notes }
}

// Pure: settings with every ws-owned hook entry removed (for --uninstall).
export function removeHooks(settings, tool) {
  const out = structuredClone(settings || {})
  const changes = []
  for (const [event, name] of Object.entries(EVENTS)) {
    const groups = out.hooks?.[name]
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      const before = (g.hooks || []).length
      g.hooks = (g.hooks || []).filter((h) => !(h.type === "command" && classifyHook(h.command, tool, event) === "ours"))
      if (g.hooks.length < before) changes.push(`removed ${name}`)
    }
    out.hooks[name] = groups.filter((g) => g.hooks.length)
    if (!out.hooks[name].length) delete out.hooks[name]
  }
  if (out.hooks && !Object.keys(out.hooks).length) delete out.hooks
  return { settings: out, changes }
}

async function readSettings(file) {
  let text
  try { text = await fs.readFile(file, "utf-8") } catch (e) {
    if (e.code === "ENOENT") return { text: null, json: {} }
    throw e
  }
  try { return { text, json: text.trim() ? JSON.parse(text) : {} } } catch {
    throw new Error(`${store.tildify(file)} is not plain JSON (comments aren't supported); add the hooks by hand (see docs/CONFIGURATION.md)`)
  }
}

// Write only if nobody changed the file since we read it; keep a timestamped backup;
// replace atomically so an interruption can't leave half a settings file.
async function writeSettings(file, before, json) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // The lock keeps two setup runs apart; the re-read catches an edit made since we read
  // (the window left is the few milliseconds between this check and the rename).
  return store.withLock(file + ".ws-setup", async () => {
    const now = await fs.readFile(file, "utf-8").catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)))
    if (now !== before) throw new Error(`${store.tildify(file)} changed while setup ran; run it again`)
    let backup = null
    if (before !== null) {
      // Backups keep the original's permissions (settings files are often 0600).
      const mode = (await fs.stat(file)).mode & 0o7777
      backup = `${file}.bak-ws-${new Date().toISOString().replace(/[:.]/g, "-")}`
      await fs.writeFile(backup, before, { flag: "wx", mode })
      await fs.chmod(backup, mode)
    }
    await store.writeFileAtomic(file, JSON.stringify(json, null, 2) + "\n")
    return backup
  })
}

// Every external command runs with the env setup was given (HOME, PATH, CODEX_HOME, …),
// never the ambient one: that's what keeps a fake HOME in tests away from real configs.
const runs = (cmd, args = ["--version"], env = process.env) => {
  const r = spawnSync(cmd, args, { stdio: "ignore", env })
  return !r.error && r.status === 0
}
const exists = (p) => fs.access(p).then(() => true, () => false)

// Which tools to set up: explicit flags win; otherwise every tool that's installed.
export async function detectTools({ claude, codex, gemini, env = process.env } = {}) {
  if (claude || codex || gemini) return [claude && "claude", codex && "codex", gemini && "gemini"].filter(Boolean)
  const out = []
  if (runs("claude", undefined, env) || (await exists(claudeDir(env)))) out.push("claude")
  if (runs("codex", undefined, env) || (await exists(codexDir(env)))) out.push("codex")
  if (runs("gemini", undefined, env) || (await exists(geminiDir(env)))) out.push("gemini")
  return out
}

// `node` on PATH survives Node upgrades; a versioned install path (Homebrew Cellar, nvm) doesn't.
const nodeCommand = (env) => (runs("node", ["-v"], env) ? "node" : process.execPath)

// ---------------------------------------------------------------- MCP

// What's registered now: { command, args, env } or null. Claude has no JSON output, so
// its text form is parsed; Codex has --json.
export function parseClaudeMcpGet(text) {
  const cmd = text.match(/^\s*Command:\s*(.*)$/m)?.[1]?.trim()
  if (!cmd) return null
  const args = text.match(/^\s*Args:\s*(.*)$/m)?.[1]?.trim() || ""
  const scope = text.match(/^\s*Scope:\s*(.*)$/m)?.[1]?.trim() || ""
  const env = {}
  const envBlock = text.split(/^\s*Environment:\s*$/m)[1] || ""
  for (const line of envBlock.split("\n")) {
    const m = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2]
    else if (line.trim() && !/^\s/.test(line)) break
  }
  return { command: cmd, args, env, user: /user/i.test(scope) }
}

function currentMcp(tool, env) {
  if (tool === "claude") {
    const r = spawnSync("claude", ["mcp", "get", "ws"], { encoding: "utf-8", env })
    return r.status === 0 ? parseClaudeMcpGet(r.stdout) : null
  }
  const r = spawnSync("codex", ["mcp", "get", "ws", "--json"], { encoding: "utf-8", env })
  if (r.status !== 0) return null
  try {
    const t = JSON.parse(r.stdout).transport || {}
    return { command: t.command, args: (t.args || []).join(" "), argv: t.args || [], env: t.env || {}, user: true }
  } catch { return null }
}

// Up to date only if it runs this checkout's server, with the right pin, through an
// executable that still exists (an upgraded Node's old Cellar path doesn't).
const commandWorks = (cmd, env) => cmd === "node"
  ? runs("node", ["-v"], env)
  : /(^|\/)node(\.exe)?$/.test(String(cmd)) && existsSync(cmd) && runs(cmd, ["-v"], env)
const mcpMatches = (cur, root, pin, env) => cur && cur.args === MCP && (pin ? cur.env.WS_ROOT === root : !cur.env.WS_ROOT) && commandWorks(cur.command, env)
const isWsServer = (cur) => cur && /(^|\/)ws\/mcp\/server\.mjs$/.test(cur.args)

function mcpAddCommand(tool, root, pin, env, keepEnv = {}) {
  const { WS_ROOT: _old, ...other } = keepEnv || {}
  const pins = [...Object.entries(other).map(([k, v]) => `${k}=${v}`), ...(pin ? [`WS_ROOT=${root}`] : [])]
  // Claude's -e takes several values, so it must come after the server name.
  return tool === "claude"
    ? ["claude", "mcp", "add", "--scope", "user", "ws", ...pins.flatMap((e) => ["-e", e]), "--", nodeCommand(env), MCP]
    : ["codex", "mcp", "add", ...pins.flatMap((e) => ["--env", e]), "ws", "--", nodeCommand(env), MCP]
}
function restoreCommand(tool, cur) {
  const pins = Object.entries(cur.env || {}).map(([k, v]) => `${k}=${v}`)
  return tool === "claude"
    ? ["claude", "mcp", "add", "--scope", "user", "ws", ...pins.flatMap((e) => ["-e", e]), "--", cur.command, cur.args]
    : ["codex", "mcp", "add", ...pins.flatMap((e) => ["--env", e]), "ws", "--", cur.command, ...(cur.argv || [cur.args])]
}
// Gemini CLI: the MCP server lives in the same settings.json as the hooks, so ws edits it
// there (one read, one write, one backup) instead of going through \`gemini mcp\`.
const geminiCur = (settings) => {
  const s = settings?.mcpServers?.ws
  if (!s || typeof s !== "object") return null
  const argv = Array.isArray(s.args) ? s.args.map(String) : []
  return { command: s.command, args: argv.join(" "), argv, env: s.env && typeof s.env === "object" ? s.env : {}, user: true }
}

// Pure: settings with mcpServers.ws added or brought up to date. A different server
// registered as "ws" is left alone.
export function mergeGeminiMcp(settings, { root, pin, command, check = () => true }) {
  const out = structuredClone(settings || {})
  const cur = geminiCur(out)
  // Other env vars the user put on the entry are kept; only WS_ROOT is ws's to set.
  const { WS_ROOT: _oldRoot, ...otherEnv } = cur?.env || {}
  const env = { ...otherEnv, ...(pin ? { WS_ROOT: root } : {}) }
  const want = { command, args: [MCP], ...(Object.keys(env).length ? { env } : {}) }
  if (cur && !isWsServer(cur)) return { settings: out, changes: [], notes: [`a different server is registered as "ws" (${cur.args}); left as is`] }
  if (cur && cur.args === MCP && (pin ? cur.env.WS_ROOT === root : !cur.env.WS_ROOT) && check(cur.command)) return { settings: out, changes: [], notes: [] }
  // Keep any other keys the user set on the entry (trust, timeout, …).
  const { env: _oldEnv, ...keep } = out.mcpServers?.ws || {}
  out.mcpServers = { ...(out.mcpServers || {}), ws: { ...keep, ...want } }
  return { settings: out, changes: [cur ? "updated MCP server ws" : "added MCP server ws"], notes: [] }
}

export function removeGeminiMcp(settings) {
  const out = structuredClone(settings || {})
  const cur = geminiCur(out)
  if (!cur) return { settings: out, changes: [], notes: [] }
  if (!isWsServer(cur)) return { settings: out, changes: [], notes: [`"ws" points at another server (${cur.args}); left as is`] }
  delete out.mcpServers.ws
  if (!Object.keys(out.mcpServers).length) delete out.mcpServers
  return { settings: out, changes: ["removed MCP server ws"], notes: [] }
}

const mcpRemoveCommand = (tool) => (tool === "claude" ? ["claude", "mcp", "remove", "--scope", "user", "ws"] : ["codex", "mcp", "remove", "ws"])

function run(cmd, log, env) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf-8", env })
  if (r.error || r.status !== 0) {
    log(`  failed: ${(r.stderr || r.stdout || r.error?.message || r.status).toString().trim().split("\n")[0]}`)
    return false
  }
  return true
}

// ---------------------------------------------------------------- CLI link

const linkPath = (env) => path.join(env.HOME || os.homedir(), ".local", "bin", "ws")
async function linkState(target) {
  let st
  try { st = await fs.lstat(target) } catch { return { kind: "none" } }
  if (!st.isSymbolicLink()) return { kind: "foreign" }
  const to = path.resolve(path.dirname(target), await fs.readlink(target))
  if (to === BIN || (await fs.realpath(to).catch(() => null)) === (await fs.realpath(BIN))) return { kind: "ours", to }
  // A link to another checkout of ws (moved, re-cloned or deleted) is ours to update.
  if (/(^|\/)ws\/bin\/ws\.mjs$/.test(to)) return { kind: "stale", to }
  return { kind: "foreign", to }
}

// ---------------------------------------------------------------- setup

// WSL pitfalls that make hooks fail silently later: a Windows node.exe first on PATH,
// or ws / its data on a Windows drive (/mnt/c). Returns warnings; changes nothing.
export function wslWarnings({ env = process.env, bin = BIN, root = store.ROOT, wsl = isWsl(env) } = {}) {
  if (!wsl) return []
  const out = []
  const r = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf-8", env })
  const node = (r.stdout || "").trim()
  if (onWindowsDrive(node) || /\.exe$/i.test(node)) out.push(`\`node\` on PATH is the Windows one (${node}). Install Node inside WSL (for example with nvm) so hooks can run ws.`)
  if (onWindowsDrive(bin)) out.push(`ws is on a Windows drive (${bin}). Clone it inside WSL (for example under ~/) instead: /mnt/c is slow from Linux.`)
  if (onWindowsDrive(root)) out.push(`the data folder is on a Windows drive (${root}). Keep it inside WSL: /mnt/c is slow from Linux and drops Linux file permissions.`)
  return out
}

export async function runSetup({ tools, link = true, hooks = true, mcp = true, dryRun = false, env = process.env, log = console.log } = {}) {
  if (platformProblem()) throw new Error(platformProblem())
  if (store.ROOT_PROBLEM) throw new Error(store.ROOT_PROBLEM)
  for (const w of wslWarnings({ env })) log(`warning (WSL): ${w}`)
  const home = env.HOME || os.homedir()
  const root = store.ROOT
  const pin = needsPin(root, home)
  const say = (s) => log((dryRun ? "[dry run] " : "") + s)
  const problems = []

  if (!runs("node", ["-v"], env)) log("warning: `node` isn't on your PATH. Hooks run `ws` through `#!/usr/bin/env node`, so Claude Code and Codex must see node on theirs.")

  // 1. Data folder
  if (!(await exists(path.join(root, "ws")))) {
    say(`create ${store.tildify(root)}`)
    if (!dryRun) {
      await fs.mkdir(path.join(root, "ws"), { recursive: true })
      await fs.mkdir(path.join(root, "procedures"), { recursive: true })
    }
  } else log(`data: ${store.tildify(root)}`)

  // 2. CLI on PATH (~/.local/bin/ws -> bin/ws.mjs)
  let wsPath = BIN
  if (link) {
    const target = linkPath(env)
    const st = await linkState(target)
    if (st.kind === "ours") wsPath = target
    else if (st.kind === "foreign") log(`skip link: ${store.tildify(target)} exists and isn't a ws link; hooks will call ${store.tildify(BIN)} directly`)
    else {
      say(st.kind === "stale" ? `relink ${store.tildify(target)} (was ${store.tildify(st.to)}) -> ${store.tildify(BIN)}` : `link ${store.tildify(target)} -> ${store.tildify(BIN)}`)
      if (!dryRun) {
        await fs.mkdir(path.dirname(target), { recursive: true })
        if (st.kind === "stale") await fs.rm(target)
        await fs.symlink(BIN, target)
      }
      wsPath = target
    }
    if (wsPath === target && !(env.PATH || "").split(path.delimiter).includes(path.dirname(target))) {
      log(`note: ${store.tildify(path.dirname(target))} is not on your PATH; add it to use \`ws\` from a terminal`)
    }
  }

  // 3. Hooks (and, for Gemini, its MCP entry: same file, same write)
  for (const tool of tools) {
    const gem = tool === "gemini"
    if (!hooks && !(gem && mcp)) continue
    const file = settingsFile(tool, env)
    const what = gem ? (hooks && mcp ? "hooks + MCP" : hooks ? "hooks" : "MCP") : "hooks"
    try {
      const { text, json } = await readSettings(file)
      let { settings, changes, notes } = hooks ? mergeHooks(json, tool, { wsPath, root, home }) : { settings: json, changes: [], notes: [] }
      if (gem && mcp) {
        const m = mergeGeminiMcp(settings, { root, pin, command: nodeCommand(env), check: (c) => commandWorks(c, env) })
        settings = m.settings; changes = [...changes, ...m.changes]; notes = [...notes, ...m.notes]
      }
      for (const n of notes) log(`${tool} ${what}: ${n}`)
      if (!changes.length) { log(`${tool} ${what}: up to date (${store.tildify(file)})`); continue }
      say(`${tool} ${what}: ${changes.join(", ")} in ${store.tildify(file)}`)
      if (!dryRun) {
        const backup = await writeSettings(file, text, settings)
        if (backup) log(`  backup: ${store.tildify(backup)}`)
      }
      if (tool === "codex") log("  Codex asks you to trust new hooks once: run /hooks in Codex and approve the two ws entries.")
    } catch (e) {
      problems.push(`${tool} ${what}: ${e.message}`)
      log(`${tool} ${what}: ${e.message}`)
    }
  }

  // 4. MCP server: add, or replace a ws registration that points somewhere else.
  if (mcp) {
    for (const tool of tools.filter((t) => t !== "gemini")) {
      if (!runs(tool, undefined, env)) { log(`${tool} MCP: \`${tool}\` not found on PATH; run later:\n  ${mcpAddCommand(tool, root, pin, env).map(q).join(" ")}`); continue }
      const cur = currentMcp(tool, env)
      // Re-adding keeps any other env vars the user set on the entry.
      const add = mcpAddCommand(tool, root, pin, env, isWsServer(cur) ? cur.env : {})
      const shown = add.map(q).join(" ")
      if (mcpMatches(cur, root, pin, env)) { log(`${tool} MCP: up to date`); continue }
      if (cur && !isWsServer(cur)) { log(`${tool} MCP: a different server is registered as "ws" (${cur.args}); left as is`); continue }
      if (cur && !cur.user) { log(`${tool} MCP: "ws" is registered in a project or local scope; update it by hand:\n  ${shown}`); continue }
      say(`${tool} MCP: ${cur ? "update" : "add"}: ${shown}`)
      if (!dryRun) {
        if (cur && !run(mcpRemoveCommand(tool), log, env)) { problems.push(`${tool} MCP: couldn't remove the old registration`); continue }
        if (!run(add, log, env)) {
          // Put the previous registration back rather than leave the tool without ws.
          if (cur) {
            const restore = restoreCommand(tool, cur)
            log(run(restore, log, env) ? "  restored the previous registration" : `  couldn't restore the previous registration; it was: ${restore.map(q).join(" ")}`)
          }
          problems.push(`${tool} MCP: registration failed; run by hand: ${shown}`)
        }
      }
    }
  }
  return { problems }
}

// ---------------------------------------------------------------- uninstall

export async function runUninstall({ tools, dryRun = false, env = process.env, log = console.log } = {}) {
  const say = (s) => log((dryRun ? "[dry run] " : "") + s)
  const problems = []
  for (const tool of tools) {
    const file = settingsFile(tool, env)
    try {
      const { text, json } = await readSettings(file)
      let { settings, changes } = removeHooks(json, tool)
      if (tool === "gemini") {
        const m = removeGeminiMcp(settings)
        settings = m.settings; changes = [...changes, ...m.changes]
        for (const n of m.notes) log(`gemini MCP: ${n}`)
      }
      if (!changes.length) log(`${tool} hooks: none to remove`)
      else {
        say(`${tool} hooks: ${changes.join(", ")} in ${store.tildify(file)}`)
        if (!dryRun) {
          const backup = await writeSettings(file, text, settings)
          if (backup) log(`  backup: ${store.tildify(backup)}`)
        }
      }
    } catch (e) { problems.push(`${tool} hooks: ${e.message}`); log(`${tool} hooks: ${e.message}`) }

    if (tool === "gemini") continue // its MCP entry was in the settings file above
    if (!runs(tool, undefined, env)) { log(`${tool} MCP: \`${tool}\` not found; if registered, remove with: ${mcpRemoveCommand(tool).join(" ")}`); continue }
    const cur = currentMcp(tool, env)
    if (!cur) log(`${tool} MCP: not registered`)
    else if (!isWsServer(cur)) log(`${tool} MCP: "ws" points at another server (${cur.args}); left as is`)
    else {
      say(`${tool} MCP: ${mcpRemoveCommand(tool).join(" ")}`)
      if (!dryRun && !run(mcpRemoveCommand(tool), log, env)) problems.push(`${tool} MCP: remove failed`)
    }
  }
  const target = linkPath(env)
  const st = await linkState(target)
  if (st.kind === "ours" || st.kind === "stale") {
    say(`remove ${store.tildify(target)}`)
    if (!dryRun) await fs.rm(target)
  }
  log(`Your data in ${store.tildify(store.ROOT)} was not touched. Delete it yourself if you no longer want it.`)
  return { problems }
}
