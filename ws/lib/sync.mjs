// `ws sync`: keep $WS_ROOT the same on several machines through git (see docs/SYNC.md).
//
// The data folder is a git repo (and each share under shares/<name> is its own repo). A sync
// commits local changes, fetches, merges and pushes. ws's own record files (open.md,
// decisions.md, WORKSTREAM.md) merge record by record through a merge driver (merge.mjs), so
// two machines adding items at once never leave conflict markers. Everything else (session
// logs, inbox entries, drafts) is one file per session and doesn't collide.
//
// Safety:
// - Off unless config.json has `sync.remote` or `sync.shares`; never run by tests or hooks in
//   the foreground. Hooks and writes only start a detached `ws sync --quiet`.
// - The merge runs while holding ws's own locks on every record file it can change, so a ws
//   write can't land halfway through it and be lost. A merge that fails is aborted
//   (`git merge --abort`), leaving the local commits in place; nothing is ever force-pushed.
// - A clone whose merge driver isn't registered (a fresh clone, a moved install) registers it
//   before merging; if that fails, the sync stops instead of falling back to a text merge.
import { execFile, spawn } from "node:child_process"
import { promises as fs, existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import * as store from "./store.mjs"
import { mergerFor } from "./merge.mjs"

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ws.mjs")
const BRANCH = "main"
const RECORD_FILES = ["open.md", "decisions.md", "WORKSTREAM.md"]

// Never synced: this machine's settings, its queue (jobs point at local transcripts), locks,
// temp files, the trash, eval copies of transcripts, and (in the main repo) the shares, which
// are repos of their own.
const LOCAL_FILES = [".sync-renames.log", ".sync-state.json", "sync-problems.log"]
const IGNORE_MAIN = ["config.json", "config.json.bak*", "queue/", "shares/", "*.lock/", "*.takeover/", "*.tmp", "hook-errors.log", "eval/transcripts/", "eval/reports/", ".trash/", ...LOCAL_FILES]
const IGNORE_SHARE = ["queue/", "*.lock/", "*.takeover/", "*.tmp", ...LOCAL_FILES]
// Line lists merge as a union: two machines each adding a line (an ignored folder, an ignore
// rule written by another ws version) is not a conflict.
const ATTRIBUTES = [...RECORD_FILES.map((f) => `ws/*/${f} merge=ws`), ".gitignore merge=union", ".gitattributes merge=union", "ignore.txt merge=union"]

export const enabled = () => store.LOCAL.enabled

export function repos() {
  const out = [{ name: "main", dir: store.ROOT, remote: store.LOCAL.remote, ignore: IGNORE_MAIN }]
  for (const s of store.LOCAL.shares) out.push({ name: s.name, dir: s.dir, remote: s.remote, ignore: IGNORE_SHARE })
  return out
}

// ------------------------------------------------------------------------ git

function git(dir, args, { timeout = 30_000, allowFail = true } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: dir, timeout, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        // Never wait on a password prompt or an unknown host from a background sync.
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=8",
        LC_ALL: "C",
      },
    }, (err, stdout, stderr) => {
      const r = { code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), killed: !!err?.killed }
      if (err && !allowFail) reject(new Error(`git ${args[0]} failed in ${store.tildify(dir)}: ${r.stderr.trim() || err.message}`))
      else resolve(r)
    })
  })
}

async function ensureLines(file, lines, header) {
  const cur = (await store.readText(file)) || ""
  const have = new Set(cur.split("\n").map((l) => l.trim()))
  const add = lines.filter((l) => !have.has(l))
  if (!add.length) return false
  await store.writeFileAtomic(file, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${cur ? "" : `# ${header}\n`}${add.join("\n")}\n`)
  return true
}

// The driver is registered per clone (git never takes merge drivers from the repo itself).
export function driverCommand() {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  return `${q(process.execPath)} ${q(BIN)} merge-driver %O %A %B %P`
}

export async function ensureRepo(repo) {
  await fs.mkdir(repo.dir, { recursive: true })
  if (!existsSync(path.join(repo.dir, ".git"))) {
    await git(repo.dir, ["init", "-q", "-b", BRANCH], { allowFail: false })
  }
  await ensureLines(path.join(repo.dir, ".gitignore"), repo.ignore, "ws: never synced (this machine's own)")
  await ensureLines(path.join(repo.dir, ".gitattributes"), ATTRIBUTES, "ws: record files merge item by item (ws merge-driver)")
  // A file that was tracked before it was ignored (config.json in older data folders) stops
  // being tracked here; the file itself stays.
  for (const f of ["config.json"]) {
    if ((await git(repo.dir, ["ls-files", "--error-unmatch", f])).code === 0) await git(repo.dir, ["rm", "-q", "--cached", f])
  }
  const set = async (k, v) => {
    if ((await git(repo.dir, ["config", "--local", "--get", k])).stdout.trim() !== v) await git(repo.dir, ["config", "--local", k, v], { allowFail: false })
  }
  await set("merge.ws.name", "ws record merge")
  await set("merge.ws.driver", driverCommand())
  if (!(await git(repo.dir, ["config", "user.email"])).stdout.trim()) {
    await set("user.name", `ws (${store.LOCAL.machine})`)
    await set("user.email", `ws@${store.LOCAL.machine}.invalid`)
  }
  if (repo.remote) {
    const cur = (await git(repo.dir, ["remote", "get-url", "origin"])).stdout.trim()
    if (!cur) await git(repo.dir, ["remote", "add", "origin", repo.remote], { allowFail: false })
    else if (cur !== repo.remote) await git(repo.dir, ["remote", "set-url", "origin", repo.remote], { allowFail: false })
  }
  if ((await git(repo.dir, ["config", "--local", "--get", "merge.ws.driver"])).stdout.trim() !== driverCommand()) {
    throw new Error(`couldn't register the ws merge driver in ${store.tildify(repo.dir)}`)
  }
}

async function commitAll(repo) {
  await git(repo.dir, ["add", "-A"], { allowFail: false })
  const staged = await git(repo.dir, ["diff", "--cached", "--quiet"])
  if (staged.code === 0) return false
  // The message carries no content: logs and items are the content.
  await git(repo.dir, ["commit", "-q", "--no-verify", "-m", `ws sync: ${store.LOCAL.machine}`], { allowFail: false })
  return true
}

const hasRef = async (dir, ref) => (await git(dir, ["rev-parse", "-q", "--verify", ref])).code === 0
const isAncestor = async (dir, a, b) => (await git(dir, ["merge-base", "--is-ancestor", a, b])).code === 0

// Take ws's locks on every record file the incoming merge can change, in a fixed order.
async function withRecordLocks(files, fn) {
  const sorted = [...new Set(files)].sort()
  const take = (i) => (i >= sorted.length ? fn() : store.withLock(sorted[i], () => take(i + 1)))
  return take(0)
}

// One repo: commit, fetch, merge, push. Returns { repo, status, detail? } where status is
// local (no remote), offline, pushed, up-to-date or conflict.
export async function syncRepo(repo) {
  await ensureRepo(repo)
  return store.withLock(path.join(repo.dir, ".sync"), async () => {
    // A sync killed in the middle of a merge leaves it half done: undo that first (the local
    // commits from before it are untouched), then start over.
    if (existsSync(path.join(repo.dir, ".git", "MERGE_HEAD"))) await git(repo.dir, ["merge", "--abort"])
    await commitAll(repo)
    if (!repo.remote) return { repo: repo.name, status: "local" }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const f = await git(repo.dir, ["fetch", "-q", "origin"], { timeout: 30_000 })
      if (f.code !== 0) return { repo: repo.name, status: "offline", detail: f.stderr.trim().split("\n").pop() }
      const remoteRef = `refs/remotes/origin/${BRANCH}`
      const haveHead = await hasRef(repo.dir, "HEAD")
      if (await hasRef(repo.dir, remoteRef)) {
        if (!haveHead || !(await isAncestor(repo.dir, remoteRef, "HEAD"))) {
          const merged = await mergeIncoming(repo, remoteRef, haveHead)
          if (merged.status === "conflict") return merged
        }
        if (await isAncestor(repo.dir, "HEAD", remoteRef)) return { repo: repo.name, status: "up-to-date" }
      } else if (!haveHead) return { repo: repo.name, status: "up-to-date" } // nothing anywhere yet
      const p = await git(repo.dir, ["push", "-q", "origin", `HEAD:${BRANCH}`], { timeout: 60_000 })
      if (p.code === 0) return { repo: repo.name, status: "pushed" }
      if (!/rejected|non-fast-forward|fetch first/i.test(p.stderr)) return { repo: repo.name, status: "offline", detail: p.stderr.trim().split("\n").pop() }
      // Someone pushed between our fetch and push: fetch and merge again.
    }
    return { repo: repo.name, status: "offline", detail: "remote kept moving; will retry next sync" }
  })
}

async function mergeIncoming(repo, remoteRef, haveHead) {
  if (!haveHead) {
    // A fresh clone with local files but no commits yet (or none at all): adopt the remote
    // history, then lay local files back on top as a commit and merge as usual.
    const local = (await git(repo.dir, ["status", "--porcelain"])).stdout.trim()
    if (!local) {
      await git(repo.dir, ["reset", "-q", "--hard", remoteRef], { allowFail: false })
      return { status: "ok" }
    }
  }
  const changed = haveHead
    ? (await git(repo.dir, ["diff", "--name-only", `HEAD...${remoteRef}`])).stdout.split("\n").filter(Boolean)
    : (await git(repo.dir, ["ls-tree", "-r", "--name-only", remoteRef])).stdout.split("\n").filter(Boolean)
  // A workstream folder that only exists on the other side has no local writer to hold off.
  const locks = changed.filter((f) => RECORD_FILES.includes(path.basename(f))).map((f) => path.join(repo.dir, f)).filter((f) => existsSync(path.dirname(f)))
  return withRecordLocks(locks, async () => {
    await commitAll(repo) // anything written since the first commit, now that writers are held off
    await fs.rm(path.join(repo.dir, ".sync-renames.log"), { force: true })
    const m = await git(repo.dir, ["merge", "-q", "--no-edit", "--allow-unrelated-histories", "-m", `ws sync: merge on ${store.LOCAL.machine}`, remoteRef], { timeout: 60_000 })
    if (m.code !== 0) {
      const files = (await git(repo.dir, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean)
      await git(repo.dir, ["merge", "--abort"])
      return { repo: repo.name, status: "conflict", detail: files.length ? `couldn't merge ${files.join(", ")}` : (m.stderr || m.stdout).trim().split("\n").slice(-2).join(" ") }
    }
    return { status: "ok" }
  })
}

export async function syncAll() {
  if (!enabled()) throw new Error("sync isn't set up: add sync.remote or sync.shares to config.json (docs/SYNC.md)")
  const results = []
  for (const repo of repos()) {
    try { results.push(await syncRepo(repo)) } catch (e) {
      // Another sync holds the lock: it will carry these changes too.
      if (/Timed out waiting for lock .*\.sync\.lock/.test(e.message)) results.push({ repo: repo.name, status: "busy" })
      else results.push({ repo: repo.name, status: "error", detail: e.message })
    }
    const file = path.join(repo.dir, ".sync-renames.log")
    const renames = await store.readText(file).catch(() => null)
    if (renames?.trim()) results[results.length - 1].renames = renames.trim().split("\n")
    await fs.rm(file, { force: true }) // reported once
  }
  // Last outcome, for the session-start note (a background sync that stopped says so there).
  if (!results.every((r) => r.status === "busy")) {
    await store.writeFileAtomic(path.join(store.ROOT, ".sync-state.json"), JSON.stringify({ at: new Date().toISOString(), machine: store.LOCAL.machine, results }, null, 2) + "\n").catch(() => {})
  }
  return results
}

export async function status() {
  const out = []
  for (const repo of repos()) {
    if (!existsSync(path.join(repo.dir, ".git"))) { out.push({ repo: repo.name, dir: repo.dir, remote: repo.remote, state: "not set up yet (run ws sync)" }); continue }
    const pending = (await git(repo.dir, ["status", "--porcelain"])).stdout.split("\n").filter(Boolean).length
    let ahead = null, behind = null
    if (await hasRef(repo.dir, `refs/remotes/origin/${BRANCH}`) && await hasRef(repo.dir, "HEAD")) {
      const c = (await git(repo.dir, ["rev-list", "--left-right", "--count", `HEAD...origin/${BRANCH}`])).stdout.trim().split(/\s+/)
      ahead = Number(c[0]); behind = Number(c[1])
    }
    const last = (await git(repo.dir, ["log", "-1", "--format=%cr", `origin/${BRANCH}`])).stdout.trim() || null
    out.push({ repo: repo.name, dir: repo.dir, remote: repo.remote, pending, ahead, behind, last })
  }
  return out
}

// ----------------------------------------------------------------- merge driver
// git calls: ws merge-driver %O %A %B %P. Writes the result over %A; exit 1 makes git
// report a conflict, which the sync then aborts.
export async function runMergeDriver(baseFile, oursFile, theirsFile, relPath) {
  const merger = mergerFor(relPath)
  if (!merger) return 1
  const [b, o, t] = await Promise.all([baseFile, oursFile, theirsFile].map((f) => store.readText(f).then((x) => x || "")))
  const { text, renames } = merger(b, o, t)
  await fs.writeFile(oursFile, text)
  if (renames.length) {
    // Reported by `ws sync`; the repo root is the cwd git runs drivers in.
    await fs.appendFile(".sync-renames.log", renames.map(([from, to]) => `${path.dirname(relPath).split("/").pop()}: ${from} -> ${to} (same ID added on two machines)`).join("\n") + "\n")
  }
  return 0
}

// ----------------------------------------------------------------- background
// After a write (CLI command, MCP call, hook), start a detached `ws sync --quiet`; it waits a
// moment so a burst of writes goes out as one commit.
let kickTimer = null
export function kick({ delayMs = 0 } = {}) {
  if (!enabled() || !store.LOCAL.auto || process.env.WS_NO_SPAWN === "1") return
  const go = () => {
    kickTimer = null
    const [cmd, args] = existsSync(BIN) ? [process.execPath, [BIN]] : ["ws", []]
    try {
      const child = spawn(cmd, [...args, "sync", "--quiet", "--wait", "2"], { detached: true, stdio: "ignore", env: { ...process.env } })
      child.on("error", () => {})
      child.unref()
    } catch {}
  }
  if (!delayMs) return go()
  if (kickTimer) clearTimeout(kickTimer)
  kickTimer = setTimeout(go, delayMs)
  kickTimer.unref?.()
}

// A background timer so machines also pick up others' changes when nothing is written here.
const LABEL = "ws.sync"
export function timerFiles({ intervalSec = 120 } = {}) {
  const node = process.execPath
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
    const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${x(node)}</string><string>${x(BIN)}</string><string>sync</string><string>--quiet</string></array>
  <key>EnvironmentVariables</key><dict><key>WS_ROOT</key><string>${x(store.ROOT)}</string><key>PATH</key><string>${x(process.env.PATH || "/usr/bin:/bin")}</string></dict>
  <key>LimitLoadToSessionType</key><array><string>Aqua</string><string>Background</string></array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`
    return [{ file, text }]
  }
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user")
  const q = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`
  return [
    { file: path.join(dir, `${LABEL}.service`), text: `[Unit]\nDescription=ws sync (workstream data across machines)\n[Service]\nType=oneshot\nEnvironment=${q(`WS_ROOT=${store.ROOT}`)}\nExecStart=${q(node)} ${q(BIN)} sync --quiet\n` },
    { file: path.join(dir, `${LABEL}.timer`), text: `[Unit]\nDescription=ws sync every ${intervalSec}s\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=${intervalSec}\nAccuracySec=10\n[Install]\nWantedBy=timers.target\n` },
  ]
}
export const TIMER_LABEL = LABEL
