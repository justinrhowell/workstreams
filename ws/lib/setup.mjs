// `ws setup`: one command to wire ws into Claude Code and Codex.
// Creates the data folder, links the CLI onto PATH, merges the SessionStart/SessionEnd
// hooks into each tool's settings, and registers the MCP server. Idempotent: running
// it again updates ws's own entries and leaves everything else alone.
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import * as store from "./store.mjs"

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, " ")), "..")
export const BIN = path.join(PKG, "bin", "ws.mjs")
export const MCP = path.join(PKG, "mcp", "server.mjs")

// Seconds. Codex waits on SessionEnd before exiting, so its end hook stays short;
// heavy work (the summarizer) is always detached.
const TIMEOUTS = { claude: { start: 10, end: 20 }, codex: { start: 10, end: 3 } }
const EVENTS = { start: "SessionStart", end: "SessionEnd" }

export const settingsFile = (tool, home = os.homedir()) =>
  tool === "claude" ? path.join(home, ".claude", "settings.json") : path.join(home, ".codex", "hooks.json")

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`)

// Hooks and MCP servers don't read your shell profile, so a non-default data folder
// (from WS_ROOT or XDG_DATA_HOME) is pinned into each command.
export const needsPin = (root, home = os.homedir()) => root !== path.join(home, ".local", "share", "ws")

export function hookCommand(tool, event, { wsPath, root, home } = {}) {
  const pin = needsPin(root, home) ? `WS_ROOT=${q(root)} ` : ""
  return `${pin}${q(wsPath)} hook ${tool} ${event}`
}

// `node` on PATH survives Node upgrades; a versioned install path (Homebrew Cellar, nvm) doesn't.
function nodeCommand() {
  return spawnSync("node", ["-v"], { stdio: "ignore" }).status === 0 ? "node" : process.execPath
}

const isOurs = (tool, event) => (cmd) => new RegExp(`\\bws(\\.mjs)?"?\\s+hook\\s+${tool}\\s+${event}\\b`).test(cmd || "")

// Pure: returns { settings, changes } with ws's hook entries added or updated.
export function mergeHooks(settings, tool, opts) {
  const out = structuredClone(settings || {})
  out.hooks ||= {}
  const changes = []
  for (const [event, name] of Object.entries(EVENTS)) {
    const command = hookCommand(tool, event, opts)
    const timeout = TIMEOUTS[tool][event]
    const groups = (out.hooks[name] ||= [])
    let found = false
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (h.type === "command" && isOurs(tool, event)(h.command)) {
          found = true
          if (h.command !== command || h.timeout !== timeout) {
            h.command = command
            h.timeout = timeout
            changes.push(`updated ${name}`)
          }
        }
      }
    }
    if (!found) {
      groups.push({ hooks: [{ type: "command", command, timeout }] })
      changes.push(`added ${name}`)
    }
  }
  return { settings: out, changes }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf-8")) } catch (e) {
    if (e.code === "ENOENT") return {}
    throw new Error(`${store.tildify(file)} is not valid JSON; fix it or add the hooks by hand (see docs/CONFIGURATION.md)`)
  }
}

const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0
const exists = (p) => fs.access(p).then(() => true, () => false)

// Which tools to set up: explicit flags win; otherwise every tool that's installed.
export async function detectTools({ claude, codex, home = os.homedir() } = {}) {
  if (claude || codex) return [claude && "claude", codex && "codex"].filter(Boolean)
  const out = []
  if (has("claude") || (await exists(path.join(home, ".claude")))) out.push("claude")
  if (has("codex") || (await exists(path.join(home, ".codex")))) out.push("codex")
  return out
}

export async function runSetup({ tools, link = true, hooks = true, mcp = true, dryRun = false, home = os.homedir(), env = process.env, log = console.log } = {}) {
  const root = store.ROOT
  const say = (s) => log((dryRun ? "[dry run] " : "") + s)

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
    const target = path.join(home, ".local", "bin", "ws")
    let current = null
    try { current = await fs.realpath(target) } catch {}
    if (current === (await fs.realpath(BIN))) {
      wsPath = target
    } else if (current || (await fs.lstat(target).then(() => true, () => false))) {
      log(`skip link: ${store.tildify(target)} already exists and points elsewhere; hooks will call ${store.tildify(BIN)} directly`)
    } else {
      say(`link ${store.tildify(target)} -> ${store.tildify(BIN)}`)
      if (!dryRun) {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.symlink(BIN, target)
      }
      wsPath = target
      if (!(env.PATH || "").split(path.delimiter).includes(path.dirname(target))) {
        log(`note: ${store.tildify(path.dirname(target))} is not on your PATH; add it to use \`ws\` from a terminal`)
      }
    }
  }

  // 3. Hooks
  if (hooks) {
    for (const tool of tools) {
      const file = settingsFile(tool, home)
      const before = await readJson(file)
      const { settings, changes } = mergeHooks(before, tool, { wsPath, root, home })
      if (!changes.length) { log(`${tool} hooks: up to date (${store.tildify(file)})`); continue }
      say(`${tool} hooks: ${changes.join(", ")} in ${store.tildify(file)}`)
      if (!dryRun) {
        await fs.mkdir(path.dirname(file), { recursive: true })
        if (await exists(file)) await fs.copyFile(file, `${file}.bak-ws`)
        await fs.writeFile(file, JSON.stringify(settings, null, 2) + "\n")
      }
      if (tool === "codex") log("  Codex asks you to trust new hooks once: run /hooks in Codex and approve the two ws entries.")
    }
  }

  // 4. MCP server
  if (mcp) {
    const envArgs = needsPin(root, home) ? [`WS_ROOT=${root}`] : []
    for (const tool of tools) {
      const cmd = tool === "claude"
        ? ["claude", "mcp", "add", "--scope", "user", ...envArgs.flatMap((e) => ["-e", e]), "ws", "--", nodeCommand(), MCP]
        : ["codex", "mcp", "add", ...envArgs.flatMap((e) => ["--env", e]), "ws", "--", nodeCommand(), MCP]
      const shown = cmd.map(q).join(" ")
      if (!has(tool)) { log(`${tool} MCP: \`${tool}\` not found on PATH; run later:\n  ${shown}`); continue }
      const already = spawnSync(tool, ["mcp", "get", "ws"], { stdio: "ignore" }).status === 0
      if (already) { log(`${tool} MCP: "ws" already registered (remove it with \`${tool} mcp remove ws\` to re-add)`); continue }
      say(`${tool} MCP: ${shown}`)
      if (!dryRun) {
        const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf-8" })
        if (r.status !== 0) log(`  failed (${(r.stderr || r.stdout || r.status).toString().trim()}); run it by hand`)
      }
    }
  }
}
