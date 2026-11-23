// `ws sync`: keep $WS_ROOT the same on several machines through git (see docs/SYNC.md).
//
// The data folder is a git repo (and each share under shares/<name> is its own repo). A sync
// commits local changes, fetches, merges and pushes. ws's own record files (open.md,
// decisions.md, WORKSTREAM.md) merge record by record through a merge driver (merge.mjs), so
// two machines adding items at once never leave conflict markers. Everything else (session
// logs, inbox entries, drafts) is one file per session and doesn't collide.
//
// Safety:
// - Off unless config.json has `sync.remote` or `sync.shares`; hooks and writes only start a
//   detached `ws sync --quiet`, never a foreground one.
// - The remote is data, never code or settings. Before anything incoming is merged, its tree
//   is checked: symlinks, submodules, this machine's own files (config.json, the queue, locks),
//   nested .gitattributes and ignore-rule negations are refused, and the sync stops. Outgoing
//   commits drop the same paths whatever .gitignore says. git runs with hooks off, symlinks
//   checked out as plain files, and the user's signing and fast-forward-only settings ignored.
// - The merge runs while holding ws's own locks on every record file it can change, so a ws
//   write can't land halfway through it and be lost. A merge that fails is aborted; if the
//   abort itself fails, sync stops and commits nothing until the repo is clean. Nothing is
//   ever force-pushed.
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
// temp files, the trash, eval copies of transcripts, sync's own state, and (in the main repo)
// the shares, which are repos of their own.
const LOCAL_FILES = [".sync-renames.log", ".sync-state.json", "sync-problems.log"]
const IGNORE_MAIN = ["config.json", "config.json.bak*", "queue/", "shares/", "*.lock/", "*.takeover/", "*.tmp", "hook-errors.log", "eval/transcripts/", "eval/reports/", ".trash/", ".DS_Store", ...LOCAL_FILES]
const IGNORE_SHARE = ["config.json", "queue/", "*.lock/", "*.takeover/", "*.tmp", ".DS_Store", ...LOCAL_FILES]
// Line lists merge as a union: two machines each adding a line is not a conflict.
const ATTRIBUTES = [...RECORD_FILES.map((f) => `ws/*/${f} merge=ws`), ".gitignore merge=union", ".gitattributes merge=union", "ignore.txt merge=union"]

// The same rules as code, so they hold whatever a (possibly remote-edited) .gitignore says.
// Compared case-folded and Unicode-normalized: on a case-insensitive disk (macOS) "Config.json"
// is config.json.
export const fold = (s) => String(s).normalize("NFC").toLowerCase()
// Sync carries plain-ASCII names only. Disks fold more than ASCII case (macOS treats some
// non-ASCII letters as equal to ASCII ones), so with non-ASCII names no comparison here could
// be sure two names are different files. ws's own names are always ASCII.
const ASCII_NAME = /^[\x20-\x7e]+$/
export function forbidden(rel, kind) {
  if (!rel.split("/").every((p) => ASCII_NAME.test(p) && p !== "." && p !== "..")) return "not a plain-ASCII name"
  if (rel === ".gitignore" || rel === ".gitattributes") return null
  if ([".gitignore", ".gitattributes"].includes(fold(rel))) return "a case variant of a git file"
  rel = fold(rel)
  const parts = rel.split("/")
  const base = parts[parts.length - 1]
  if (parts.some((p) => p === ".git" || (p.startsWith(".git") && p !== ".gitkeep"))) return "git metadata"
  if (parts.length === 1 && /^config\.json/.test(base)) return "this machine's settings"
  if (parts[0] === "queue") return "this machine's summary queue"
  if (kind === "main" && parts[0] === "shares") return "a share (its own repo)"
  if (parts.some((p) => p.endsWith(".lock") || p.endsWith(".takeover"))) return "a lock"
  if (base.endsWith(".tmp")) return "a temp file"
  if (parts[0] === ".trash") return "the trash"
  if (rel.startsWith("eval/transcripts/") || rel.startsWith("eval/reports/")) return "eval copies"
  if (["hook-errors.log", ...LOCAL_FILES].includes(rel)) return "sync state"
  if (base === ".ds_store") return "a Finder file"
  return null
}

// A path is checked at every level: "config.json/x" would turn this machine's settings file
// into a folder, so the protected name anywhere along the path is enough to refuse it.
export function forbiddenPath(rel, kind) {
  const parts = rel.split("/")
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/")
    if (i < parts.length && [".gitignore", ".gitattributes"].includes(fold(p))) return "git metadata"
    const why = forbidden(p, kind)
    if (why) return why
  }
  return null
}

export const enabled = () => store.LOCAL.enabled

export function repos() {
  const out = [{ name: "main", kind: "main", dir: store.ROOT, remote: store.LOCAL.remote, ignore: IGNORE_MAIN }]
  for (const s of store.LOCAL.shares) out.push({ name: s.name, kind: "share", dir: s.dir, remote: s.remote, ignore: IGNORE_SHARE })
  return out
}

// ------------------------------------------------------------------------ git

// Settings that must not come from the user's global config or from the repo: no hooks, no
// symlinks on disk, no signing prompts in a background job, merges allowed to create commits.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
  "-c", "merge.ff=true", "-c", "merge.verifySignatures=false", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "pull.rebase=false"]

let sshCmd = null
async function sshEnv() {
  if (sshCmd === null) {
    // Keep a core.sshCommand the user set; otherwise never wait on a prompt in the background.
    const own = await new Promise((r) => execFile("git", ["config", "--get", "core.sshCommand"], (e, out) => r(String(out || "").trim())))
    sshCmd = process.env.GIT_SSH_COMMAND || (own ? "" : "ssh -o BatchMode=yes -o ConnectTimeout=8")
  }
  return sshCmd ? { GIT_SSH_COMMAND: sshCmd } : {}
}

async function git(dir, args, { timeout = 30_000, allowFail = true } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...(await sshEnv()) }
  return new Promise((resolve, reject) => {
    execFile("git", [...SAFE, ...args], { cwd: dir, timeout, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const r = { code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), killed: !!err?.killed }
      if (err && !allowFail) reject(new Error(`git ${args[0]} failed in ${store.tildify(dir)}: ${r.stderr.trim() || err.message}`))
      else resolve(r)
    })
  })
}

async function ensureLines(file, lines, header) {
  // Never write through a link the remote might have planted.
  try { if ((await fs.lstat(file)).isSymbolicLink()) await fs.rm(file) } catch {}
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
  const set = async (k, v) => {
    if ((await git(repo.dir, ["config", "--local", "--get", k])).stdout.trim() !== v) await git(repo.dir, ["config", "--local", k, v], { allowFail: false })
  }
  await set("core.symlinks", "false")
  await set("merge.ws.name", "ws record merge")
  await set("merge.ws.driver", driverCommand())
  await ensureLines(path.join(repo.dir, ".gitignore"), repo.ignore, "ws: never synced (this machine's own)")
  await ensureLines(path.join(repo.dir, ".gitattributes"), ATTRIBUTES, "ws: record files merge item by item (ws merge-driver)")
  if (!(await git(repo.dir, ["config", "user.email"])).stdout.trim()) {
    await set("user.name", `ws (${store.LOCAL.machine})`)
    await set("user.email", `ws@${store.LOCAL.machine}.invalid`)
  }
  if (repo.remote) {
    const cur = (await git(repo.dir, ["remote", "get-url", "origin"])).stdout.trim()
    const pushUrl = (await git(repo.dir, ["config", "--get-all", "remote.origin.pushurl"])).stdout.trim()
    if (cur !== repo.remote || pushUrl) {
      // A new remote (or an `origin` the folder had before sync): forget what the old one had,
      // or an empty new remote would look like shared history and the old history would go out.
      // Removed and added again, so no separate push address of the old one is left behind.
      if (cur) await git(repo.dir, ["remote", "remove", "origin"], { allowFail: false })
      await git(repo.dir, ["remote", "add", "origin", repo.remote], { allowFail: false })
      const refs = (await git(repo.dir, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"])).stdout.split("\n").filter(Boolean)
      for (const r of refs) await git(repo.dir, ["update-ref", "-d", r], { allowFail: false })
    }
  }
  if ((await git(repo.dir, ["config", "--local", "--get", "merge.ws.driver"])).stdout.trim() !== driverCommand()) {
    throw new Error(`couldn't register the ws merge driver in ${store.tildify(repo.dir)}`)
  }
}

const mergeInProgress = (repo) => existsSync(path.join(repo.dir, ".git", "MERGE_HEAD"))
const unmerged = async (repo) => (await git(repo.dir, ["ls-files", "-u"])).stdout.trim() !== ""

// Index entries (mode, path) of the tree at `ref`, or of the index when ref is null.
async function entries(dir, ref) {
  const out = ref
    ? (await git(dir, ["ls-tree", "-r", "-z", "--full-tree", ref], { allowFail: false })).stdout
    : (await git(dir, ["ls-files", "-s", "-z"], { allowFail: false })).stdout
  return out.split("\0").filter(Boolean).map((e) => {
    const tab = e.indexOf("\t")
    return { mode: e.slice(0, tab).split(" ")[0], path: e.slice(tab + 1) }
  })
}

// The text of a small file at `ref`, "" when it doesn't exist; null when git can't read it or
// it is too big to be an honest rule file (fail closed).
async function smallFile(dir, ref, f, max = 64 * 1024) {
  const size = await git(dir, ["cat-file", "-s", `${ref}:${f}`])
  if (size.code !== 0) return /does not exist|not a valid object|exists on disk, but not in/i.test(size.stderr) ? "" : null
  if (Number(size.stdout.trim()) > max) return null
  const r = await git(dir, ["cat-file", "blob", `${ref}:${f}`])
  return r.code === 0 ? r.stdout : null
}

// Is everything in the incoming tree plain data this machine may take?
async function checkIncoming(repo, ref) {
  const problems = []
  const seen = new Map()
  for (const { mode, path: rel } of await entries(repo.dir, ref)) {
    // Two names one disk would treat as the same file: one could replace the other.
    const prefixes = rel.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"))
    for (const p of prefixes) {
      const k = fold(p)
      if (seen.has(k) && seen.get(k) !== p) problems.push(`${p} and ${seen.get(k)} differ only in case`)
      else seen.set(k, p)
    }
    if (mode === "120000") problems.push(`${rel} is a symlink`)
    else if (mode === "160000") problems.push(`${rel} is a submodule`)
    else {
      const why = forbiddenPath(rel, repo.kind)
      if (why) problems.push(`${rel} is ${why}`)
    }
  }
  const ignore = await smallFile(repo.dir, ref, ".gitignore")
  const attrs = await smallFile(repo.dir, ref, ".gitattributes")
  if (ignore === null) problems.push(".gitignore can't be read or is too large")
  if (attrs === null) problems.push(".gitattributes can't be read or is too large")
  // Both rule files may only hold the rules ws writes: anything else could hide a file from
  // git's own "would be overwritten" guard or change how files merge.
  const ignores = new Set([...IGNORE_MAIN, ...IGNORE_SHARE])
  for (const line of (ignore || "").split("\n")) {
    const l = line.trim()
    if (l && !l.startsWith("#") && !ignores.has(l)) problems.push(`.gitignore has "${l}"`)
  }
  // An incoming file must not land on a file this machine has outside git (its settings, a
  // queued job, anything ignored or untracked), under any spelling the disk treats as the same.
  // That includes a file landing where this machine has a folder of its own files, and a folder
  // landing where it has a file (git would delete the local one to make room). Fails closed.
  const tracked = new Set((await git(repo.dir, ["ls-files", "-z"], { allowFail: false })).stdout.split("\0").filter(Boolean).map(fold))
  const local = new Map((await git(repo.dir, ["ls-files", "-o", "-z"], { allowFail: false })).stdout.split("\0").filter(Boolean)
    .filter((f) => !tracked.has(fold(f))).map((f) => [fold(f), f]))
  const localDirs = new Map()
  for (const [k, f] of local) { const ps = k.split("/"); for (let i = 1; i < ps.length; i++) localDirs.set(ps.slice(0, i).join("/"), f) }
  for (const { path: rel } of await entries(repo.dir, ref)) {
    const k = fold(rel)
    const ps = k.split("/")
    const hit = local.get(k) || localDirs.get(k) || ps.slice(0, -1).map((_, i) => local.get(ps.slice(0, i + 1).join("/"))).find(Boolean)
    if (hit) problems.push(`${rel} would replace this machine's own ${hit}`)
  }
  const allowed = new Set(ATTRIBUTES)
  for (const line of (attrs || "").split("\n")) {
    const l = line.trim()
    if (l && !l.startsWith("#") && !allowed.has(l)) problems.push(`.gitattributes sets "${l}"`)
  }
  return problems
}

async function commitAll(repo) {
  if (mergeInProgress(repo) || (await unmerged(repo))) throw new Error(`a merge is unfinished in ${store.tildify(repo.dir)}; run \`git merge --abort\` there`)
  await git(repo.dir, ["add", "-A"], { allowFail: false })
  // Whatever .gitignore says: this machine's own files and links never leave it.
  const drop = (await entries(repo.dir, null)).filter((e) => e.mode === "120000" || e.mode === "160000" || forbiddenPath(e.path, repo.kind)).map((e) => e.path)
  if (drop.length) await git(repo.dir, ["rm", "-q", "--cached", "--", ...drop], { allowFail: false })
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

// The first time this repo meets a remote (an empty one, or one whose history it doesn't share),
// its own earlier history must not go along: older commits can hold files written before sync
// existed (old settings, anything since removed). Replace it with one commit of the current,
// already filtered tree; the old history stays here under refs/ws/pre-sync.
async function startFresh(repo) {
  const parents = (await git(repo.dir, ["rev-list", "--count", "HEAD"])).stdout.trim()
  if (parents === "1") return // already a single commit (filtered by commitAll)
  const ts = new Date().toISOString().replace(/[-:.]/g, "")
  await git(repo.dir, ["update-ref", `refs/ws/pre-sync-${ts}`, "HEAD"], { allowFail: false })
  const tree = (await git(repo.dir, ["rev-parse", "HEAD^{tree}"], { allowFail: false })).stdout.trim()
  const c = (await git(repo.dir, ["commit-tree", tree, "-m", `ws sync: start on ${store.LOCAL.machine}`], { allowFail: false })).stdout.trim()
  await git(repo.dir, ["reset", "-q", "--soft", c], { allowFail: false })
}

// Undo a half-done merge. If git can't, the repo needs a person: stop.
async function abortMerge(repo) {
  if (mergeInProgress(repo)) await git(repo.dir, ["merge", "--abort"])
  if (mergeInProgress(repo) || (await unmerged(repo))) {
    throw new Error(`couldn't undo a failed merge in ${store.tildify(repo.dir)}; run \`git merge --abort\` (or \`git reset --merge\`) there`)
  }
}

// One repo: commit, fetch, merge, push. Returns { repo, status, detail? } where status is
// local (no remote), offline, pushed, up-to-date, refused (incoming data failed the check) or
// conflict.
export async function syncRepo(repo) {
  await fs.mkdir(repo.dir, { recursive: true })
  return store.withLock(path.join(repo.dir, ".sync"), async () => {
    await ensureRepo(repo)
    // A sync killed in the middle of a merge leaves it half done: undo that first (the local
    // commits from before it are untouched), then start over.
    await abortMerge(repo)
    await commitAll(repo)
    if (!repo.remote) return { repo: repo.name, status: "local" }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const f = await git(repo.dir, ["fetch", "-q", "--prune", "--no-recurse-submodules", "origin"], { timeout: 30_000 })
      if (f.code !== 0) return { repo: repo.name, status: "offline", detail: f.stderr.trim().split("\n").pop() }
      const haveHead = await hasRef(repo.dir, "HEAD")
      // Check and merge one exact commit, so what was checked is what lands.
      const r = await git(repo.dir, ["rev-parse", "-q", "--verify", `refs/remotes/origin/${BRANCH}^{commit}`])
      const remoteRef = r.code === 0 ? r.stdout.trim() : null
      if (remoteRef) {
        if (haveHead && (await git(repo.dir, ["merge-base", "HEAD", remoteRef])).code !== 0) await startFresh(repo)
        if (!haveHead || !(await isAncestor(repo.dir, remoteRef, "HEAD"))) {
          const problems = await checkIncoming(repo, remoteRef)
          if (problems.length) {
            return { repo: repo.name, status: "refused", detail: `the remote has files ws won't take: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}` }
          }
          const merged = await mergeIncoming(repo, remoteRef, haveHead)
          if (merged.status === "conflict") return merged
        }
        if (await isAncestor(repo.dir, "HEAD", remoteRef)) return { repo: repo.name, status: "up-to-date" }
      } else if (!haveHead) return { repo: repo.name, status: "up-to-date" } // nothing anywhere yet
      else await startFresh(repo) // first push to an empty remote
      // Nothing goes out that ever added one of this machine's own files, even in older local
      // commits the remote doesn't have yet (history from before sync, shared only in part).
      const range = remoteRef ? [`${remoteRef}..HEAD`] : ["HEAD"]
      const out = (await git(repo.dir, ["log", "--format=", "--name-only", "-z", "--diff-filter=ACMRT", "--no-merges", ...range], { allowFail: false })).stdout.split("\0").map((x) => x.trim()).filter(Boolean)
      const leak = out.find((f) => forbiddenPath(f, repo.kind))
      if (leak) {
        return { repo: repo.name, status: "refused", detail: `local history this repo hasn't pushed yet holds ${leak} (${forbiddenPath(leak, repo.kind)}); ws won't publish it. See "Limits" in docs/SYNC.md.` }
      }
      const p = await git(repo.dir, ["push", "-q", "--no-verify", "origin", `HEAD:${BRANCH}`], { timeout: 60_000 })
      if (p.code === 0) return { repo: repo.name, status: "pushed" }
      if (!/rejected|non-fast-forward|fetch first/i.test(p.stderr)) return { repo: repo.name, status: "offline", detail: p.stderr.trim().split("\n").pop() }
      // Someone pushed between our fetch and push: fetch and merge again.
    }
    return { repo: repo.name, status: "offline", detail: "remote kept moving; will retry next sync" }
  })
}

async function mergeIncoming(repo, remoteRef, haveHead) {
  if (!haveHead) {
    // No local commits and no local files: take the remote as it is.
    const local = (await git(repo.dir, ["status", "--porcelain"])).stdout.trim()
    if (!local) {
      await git(repo.dir, ["reset", "-q", "--hard", remoteRef], { allowFail: false })
      return { status: "ok" }
    }
  }
  // Files the merge can touch: the diff from the merge base, or (two histories that never met)
  // everything the remote has.
  const d = haveHead ? await git(repo.dir, ["diff", "-z", "--name-only", `HEAD...${remoteRef}`]) : { code: 1 }
  const changed = d.code === 0
    ? d.stdout.split("\0").filter(Boolean)
    : (await git(repo.dir, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", remoteRef])).stdout.split("\0").filter(Boolean)
  // A workstream folder that only exists on the other side has no local writer to hold off.
  // Every local file the merge can change is locked (the record files, and the per-session
  // files: logs, drafts and inbox rows, which ws also rewrites under their own locks), plus each
  // log folder's capture lock.
  const locks = []
  for (const f of changed) {
    const full = path.join(repo.dir, f)
    if (!existsSync(path.dirname(full))) continue
    if (RECORD_FILES.includes(path.basename(f)) || existsSync(full)) locks.push(full)
    if (/^ws\/[^/]+\/log\//.test(f)) locks.push(path.join(path.dirname(full), ".capture"))
  }
  return withRecordLocks(locks, async () => {
    await commitAll(repo) // anything written since the first commit, now that writers are held off
    await fs.rm(path.join(repo.dir, ".sync-renames.log"), { force: true })
    const m = await git(repo.dir, ["merge", "-q", "--no-edit", "--no-verify", "--allow-unrelated-histories", "-m", `ws sync: merge on ${store.LOCAL.machine}`, remoteRef], { timeout: 60_000 })
    if (m.code !== 0) {
      const files = (await git(repo.dir, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean)
      await abortMerge(repo)
      await fs.rm(path.join(repo.dir, ".sync-renames.log"), { force: true }) // nothing was renumbered after all
      return { repo: repo.name, status: "conflict", detail: files.length ? `couldn't merge ${files.join(", ")}` : (m.stderr || m.stdout).trim().split("\n").slice(-2).join(" ") }
    }
    return { status: "ok" }
  })
}

export const BAD = ["conflict", "error", "refused"]

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
    try { if ((await fs.lstat(file)).isFile()) { const t = await store.readText(file); if (t?.trim()) results[results.length - 1].renames = t.trim().split("\n") } } catch {}
    await fs.rm(file, { force: true }) // reported once
  }
  // Last outcome, for the session-start note (a background sync that stopped says so there).
  if (!results.every((r) => r.status === "busy")) {
    const state = path.join(store.ROOT, ".sync-state.json")
    try { if ((await fs.lstat(state)).isSymbolicLink()) await fs.rm(state) } catch {}
    await store.writeFileAtomic(state, JSON.stringify({ at: new Date().toISOString(), machine: store.LOCAL.machine, results }, null, 2) + "\n").catch(() => {})
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
  // systemd unquoting: backslash escapes, and % is a specifier unless doubled.
  const q = (s) => `"${String(s).replace(/[\r\n]/g, "").replace(/(["\\])/g, "\\$1").replace(/%/g, "%%")}"`
  return [
    { file: path.join(dir, `${LABEL}.service`), text: `[Unit]\nDescription=ws sync (workstream data across machines)\n[Service]\nType=oneshot\nEnvironment=${q(`WS_ROOT=${store.ROOT}`)}\nExecStart=${q(node)} ${q(BIN)} sync --quiet\n` },
    { file: path.join(dir, `${LABEL}.timer`), text: `[Unit]\nDescription=ws sync every ${intervalSec}s\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=${intervalSec}\nAccuracySec=10\n[Install]\nWantedBy=timers.target\n` },
  ]
}
export const TIMER_LABEL = LABEL
