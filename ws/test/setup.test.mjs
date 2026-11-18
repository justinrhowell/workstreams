import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import os from "node:os"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-setup-"))
process.env.WS_ROOT = path.join(tmp, "data root")
const store = await import("../lib/store.mjs")
const S = await import("../lib/setup.mjs")
const { mergeHooks, removeHooks, classifyHook, hookCommand, runSetup, runUninstall, settingsFile, parseClaudeMcpGet, BIN } = S

const H = "/home/u"
const DEF = { wsPath: "/bin/ws", root: "/home/u/.local/share/ws", home: H }

test("defaultRoot: WS_ROOT (absolute), then XDG_DATA_HOME/ws, then ~/.local/share/ws", () => {
  assert.equal(store.defaultRoot({ WS_ROOT: "/x/y" }), "/x/y")
  assert.equal(store.defaultRoot({ XDG_DATA_HOME: "/data" }), "/data/ws")
  assert.equal(store.defaultRoot({ XDG_DATA_HOME: "relative" }), path.join(os.homedir(), ".local", "share", "ws"))
  assert.equal(store.defaultRoot({}), path.join(os.homedir(), ".local", "share", "ws"))
})

test("F13: a relative WS_ROOT is refused by commands, MCP and setup; hooks exit 0", () => {
  const env = { ...process.env, WS_ROOT: "data" }
  assert.equal(spawnSync(process.execPath, [BIN, "ls"], { env }).status, 1)
  assert.equal(spawnSync(process.execPath, [BIN, "hook", "claude", "start"], { env, input: "{}" }).status, 0)
  const mcp = spawnSync(process.execPath, [path.join(path.dirname(BIN), "..", "mcp", "server.mjs")], { env, input: "" })
  assert.equal(mcp.status, 1)
})

test("hookCommand quotes for sh and pins WS_ROOT for any non-default folder (incl. XDG)", () => {
  assert.equal(hookCommand("claude", "start", { ...DEF, wsPath: "/a b/ws" }), `'/a b/ws' hook claude start`)
  assert.equal(hookCommand("codex", "end", { ...DEF, root: "/my data" }), `WS_ROOT='/my data' /bin/ws hook codex end`)
  assert.equal(hookCommand("codex", "end", { ...DEF, root: "/x/it's" }), `WS_ROOT='/x/it'\\''s' /bin/ws hook codex end`)
})

test("classifyHook: only whole ws commands are ours; ws inside a custom command is not", () => {
  assert.equal(classifyHook(`"$HOME/.local/bin/ws" hook claude start`, "claude", "start"), "ours")
  assert.equal(classifyHook(`'/path with spaces/ws' hook claude start`, "claude", "start"), "ours")
  assert.equal(classifyHook(`WS_ROOT='/d' /x/ws/bin/ws.mjs hook codex end`, "codex", "end"), "ours")
  assert.equal(classifyHook(`echo a; ws hook claude start; echo b`, "claude", "start"), "embedded")
  assert.equal(classifyHook(`other-tool start`, "claude", "start"), "other")
  assert.equal(classifyHook(`ws hook claude end`, "claude", "start"), "other")
})

test("mergeHooks adds ws entries, keeps everything else, and is a no-op the second time", () => {
  const before = { model: "x", hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "other-tool start" }] }] } }
  const { settings, changes } = mergeHooks(before, "claude", DEF)
  assert.deepEqual(changes, ["added SessionStart", "added SessionEnd"])
  assert.equal(settings.model, "x")
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "other-tool start")
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, "/bin/ws hook claude end")
  assert.equal(before.hooks.SessionStart.length, 1, "input is not mutated")
  assert.deepEqual(mergeHooks(settings, "claude", DEF).changes, [])
})

test("F06: compound commands are left alone; quoted paths are recognised; duplicates are removed", () => {
  const compound = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo a; ws hook claude start; echo b" }] }] } }
  const r1 = mergeHooks(compound, "claude", DEF)
  assert.equal(r1.settings.hooks.SessionStart.length, 1)
  assert.equal(r1.settings.hooks.SessionStart[0].hooks[0].command, "echo a; ws hook claude start; echo b")
  assert.match(r1.notes[0], /custom hook already calls/)

  const quoted = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "'/bin/ws' hook claude start", timeout: 10 }] }] } }
  assert.deepEqual(mergeHooks(quoted, "claude", DEF).changes.filter((c) => /SessionStart/.test(c)), ["updated SessionStart"])

  const dupes = { hooks: { SessionEnd: [
    { hooks: [{ type: "command", command: "/bin/ws hook claude end", timeout: 20 }] },
    { hooks: [{ type: "command", command: `"$HOME/.local/bin/ws" hook claude end` }, { type: "command", command: "keep-me" }] },
  ] } }
  const r3 = mergeHooks(dupes, "claude", DEF)
  assert.ok(r3.changes.includes("removed duplicate SessionEnd"))
  const cmds = r3.settings.hooks.SessionEnd.flatMap((g) => g.hooks.map((h) => h.command))
  assert.deepEqual(cmds, ["/bin/ws hook claude end", "keep-me"])
})

test("mergeHooks updates a hand-written ws hook in place", () => {
  const before = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: `"$HOME/.local/bin/ws" hook codex end`, timeout: 99 }] }] } }
  const { settings, changes } = mergeHooks(before, "codex", DEF)
  assert.deepEqual(changes, ["added SessionStart", "updated SessionEnd"])
  assert.deepEqual(settings.hooks.SessionEnd[0].hooks[0], { type: "command", command: "/bin/ws hook codex end", timeout: 3 })
})

test("removeHooks takes out only ws's own entries", () => {
  const { settings } = mergeHooks({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other" }] }] }, theme: "dark" }, "claude", DEF)
  const r = removeHooks(settings, "claude")
  assert.deepEqual(r.changes, ["removed SessionStart", "removed SessionEnd"])
  assert.deepEqual(r.settings, { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other" }] }] }, theme: "dark" })
})

test("parseClaudeMcpGet reads command, args, env and scope", () => {
  const out = `ws:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: node\n  Args: /x/ws/mcp/server.mjs\n  Environment:\n    WS_ROOT=/d\n\nTo remove this server, run: claude mcp remove "ws" -s user\n`
  assert.deepEqual(parseClaudeMcpGet(out), { command: "node", args: "/x/ws/mcp/server.mjs", env: { WS_ROOT: "/d" }, user: true })
})

async function fakeHome(name) {
  const home = path.join(tmp, name)
  await fs.mkdir(path.join(home, ".claude"), { recursive: true })
  // No claude/codex on PATH: MCP registration is reported, not run.
  return { home, env: { HOME: home, PATH: "/usr/bin:/bin", WS_ROOT: process.env.WS_ROOT } }
}

test("runSetup: data folder, CLI link, hooks with timestamped backups; second run is a no-op", async () => {
  const { home, env } = await fakeHome("home")
  await fs.writeFile(settingsFile("claude", env), JSON.stringify({ theme: "dark" }))
  const lines = []
  const r = await runSetup({ tools: ["claude", "codex"], mcp: false, env, log: (s) => lines.push(s) })
  assert.deepEqual(r.problems, [])
  await fs.access(path.join(store.ROOT, "ws"))
  assert.equal(await fs.realpath(path.join(home, ".local", "bin", "ws")), await fs.realpath(BIN))
  assert.ok(lines.some((l) => l.includes("not on your PATH")))
  const claude = JSON.parse(await fs.readFile(settingsFile("claude", env), "utf-8"))
  assert.equal(claude.theme, "dark")
  assert.match(claude.hooks.SessionStart[0].hooks[0].command, /^WS_ROOT='.*data root' .*\/\.local\/bin\/ws hook claude start$/)
  assert.equal((await fs.readdir(path.join(home, ".claude"))).filter((f) => f.startsWith("settings.json.bak-ws-")).length, 1)

  const again = []
  await runSetup({ tools: ["claude", "codex"], mcp: false, env, log: (s) => again.push(s) })
  assert.ok(again.some((l) => l.startsWith("claude hooks: up to date")))
  assert.ok(again.some((l) => l.startsWith("codex hooks: up to date")))
})

test("F15/A2: CODEX_HOME and CLAUDE_CONFIG_DIR are where hooks go", async () => {
  const { env } = await fakeHome("home-custom")
  env.CODEX_HOME = path.join(tmp, "codex-home")
  env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude-home")
  await runSetup({ tools: ["claude", "codex"], mcp: false, link: false, env, log: () => {} })
  await fs.access(path.join(env.CODEX_HOME, "hooks.json"))
  await fs.access(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"))
})

test("F12: a link to another (moved or deleted) ws checkout is replaced; a foreign file is not", async () => {
  const { home, env } = await fakeHome("home-stale")
  const target = path.join(home, ".local", "bin", "ws")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.symlink("/gone/checkout/ws/bin/ws.mjs", target)
  await runSetup({ tools: [], mcp: false, env, log: () => {} })
  assert.equal(await fs.realpath(target), await fs.realpath(BIN))

  const { home: h2, env: e2 } = await fakeHome("home-foreign")
  const t2 = path.join(h2, ".local", "bin", "ws")
  await fs.mkdir(path.dirname(t2), { recursive: true })
  await fs.writeFile(t2, "#!/bin/sh\necho mine\n")
  const lines = []
  await runSetup({ tools: [], mcp: false, env: e2, log: (s) => lines.push(s) })
  assert.equal(await fs.readFile(t2, "utf-8"), "#!/bin/sh\necho mine\n")
  assert.ok(lines.some((l) => l.startsWith("skip link")))
})

test("invalid settings JSON is reported as a problem and the file is left untouched", async () => {
  const { env } = await fakeHome("home-bad")
  await fs.writeFile(settingsFile("claude", env), "{ // comment\n}")
  const r = await runSetup({ tools: ["claude"], mcp: false, link: false, env, log: () => {} })
  assert.match(r.problems[0], /not plain JSON/)
  assert.equal(await fs.readFile(settingsFile("claude", env), "utf-8"), "{ // comment\n}")
})

test("F20: uninstall removes ws's hooks and link, keeps other hooks and the data", async () => {
  const { home, env } = await fakeHome("home-un")
  await fs.writeFile(settingsFile("claude", env), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other" }] }] } }))
  await runSetup({ tools: ["claude"], mcp: false, env, log: () => {} })
  await runUninstall({ tools: ["claude"], env, log: () => {} })
  const after = JSON.parse(await fs.readFile(settingsFile("claude", env), "utf-8"))
  assert.deepEqual(after, { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other" }] }] } })
  await assert.rejects(fs.lstat(path.join(home, ".local", "bin", "ws")))
  await fs.access(path.join(store.ROOT, "ws"))
})

test("--dry-run writes nothing", async () => {
  const home = path.join(tmp, "home-dry")
  await runSetup({ tools: ["claude"], mcp: false, dryRun: true, env: { HOME: home, PATH: "" }, log: () => {} })
  await assert.rejects(fs.access(path.join(home, ".claude", "settings.json")))
  await assert.rejects(fs.access(path.join(home, ".local", "bin", "ws")))
})

test("F11: a config.json of null, junk or bad types never breaks hooks or the CLI", async () => {
  for (const body of ["{ not json", "null", "[]", `{"board":{"port":"x"},"llm":5}`]) {
    const root = await fs.mkdtemp(path.join(tmp, "cfg-"))
    await fs.writeFile(path.join(root, "config.json"), body)
    const env = { ...process.env, WS_ROOT: root, WS_NO_SPAWN: "1" }
    const hook = spawnSync(process.execPath, [BIN, "hook", "claude", "start"], { input: "{}", env, encoding: "utf-8" })
    assert.equal(hook.status, 0, `${body}: ${hook.stderr}`)
    const ls = spawnSync(process.execPath, [BIN, "ls"], { env, encoding: "utf-8" })
    assert.equal(ls.status, 0, `${body}: ${ls.stderr}`)
  }
})

test("F20: options meant for another command are rejected (no silent default)", () => {
  const r = spawnSync(process.execPath, [BIN, "setup", "--install"], { env: { ...process.env }, encoding: "utf-8" })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown option --install/)
})

test("setup and uninstall call the claude/codex found on the env's PATH, never the real ones", async () => {
  const { env } = await fakeHome("home-stub")
  const bin = path.join(tmp, "stub-bin")
  const calls = path.join(tmp, "stub-calls.txt")
  await fs.mkdir(bin, { recursive: true })
  for (const tool of ["claude", "codex"]) {
    // Stub: records its arguments; "mcp get" says nothing is registered.
    await fs.writeFile(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\ncase "$*" in "mcp get"*) exit 1;; esac\nexit 0\n`, { mode: 0o755 })
  }
  env.PATH = `${bin}:/usr/bin:/bin`
  await runSetup({ tools: ["claude", "codex"], link: false, hooks: false, env, log: () => {} })
  await runUninstall({ tools: ["claude", "codex"], env, log: () => {} })
  const log = await fs.readFile(calls, "utf-8")
  assert.match(log, /^claude mcp add --scope user ws -e WS_ROOT=.* -- \S*node .*\/ws\/mcp\/server\.mjs$/m, "A1: -e comes after the name")
  assert.match(log, /^codex mcp add --env WS_ROOT=.* ws -- \S*node /m)
  assert.match(log, /^claude mcp get ws$/m)
})
