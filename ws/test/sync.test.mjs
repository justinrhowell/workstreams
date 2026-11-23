// ws sync: several data folders ("machines") sharing state through a git remote.
// Each machine is its own WS_ROOT driven through the CLI in a child process (the store reads
// WS_ROOT and config.json at import), with a bare repo in a temp folder as the remote.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { mergeOpenText, mergeDecisionsText, mergeWorkstreamText } from "../lib/merge.mjs"
import { matchWorkstream } from "../lib/capture.mjs"

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ws.mjs")
const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "store.mjs")
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-sync-test-"))
const gitEnv = { GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }
// Settings a user might have globally that must not break background syncs: signing (with a
// signer that always fails) and fast-forward-only merges.
await fs.writeFile(gitEnv.GIT_CONFIG_GLOBAL, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[merge]\n\tff = only\n")

function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "merge.ff=true", ...args], { cwd: dir, encoding: "utf-8", env: { ...process.env, ...gitEnv } })
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }
}
async function bare(name) {
  const dir = path.join(tmp, `${name}.git`)
  await fs.mkdir(dir, { recursive: true })
  git(dir, "init", "-q", "--bare", "-b", "main")
  return dir
}
async function machine(name, sync, extra = {}) {
  const root = path.join(tmp, name)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ sync: { machine: name, ...sync }, ...extra }, null, 2))
  const ws = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf-8", env: { ...process.env, ...gitEnv, WS_ROOT: root, WS_NO_SPAWN: "1" } })
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }
  }
  const okWs = (...args) => {
    const r = ws(...args)
    assert.equal(r.code, 0, `ws ${args.join(" ")} on ${name} failed:\n${r.out}`)
    return r.out
  }
  return { name, root, ws, okWs, read: (rel) => fs.readFile(path.join(root, rel), "utf-8") }
}
const proj = path.join(tmp, "project")
await fs.mkdir(proj, { recursive: true })

// ------------------------------------------------------------------ merge units

const open = (next, lines) => `# Open items: T\n<!-- managed by ws; change with \`ws item\` -->\n<!-- next: ${next} -->\n\n${lines.join("\n")}\n`

test("merge: the same new ID on two machines keeps theirs and renumbers ours", () => {
  const base = open(2, ["- [ ] T-1 first"])
  const ours = open(3, ["- [ ] T-1 first", "- [ ] T-2 mine"])
  const theirs = open(3, ["- [ ] T-1 first", "- [ ] T-2 theirs"])
  const { text, renames } = mergeOpenText(base, ours, theirs)
  assert.match(text, /- \[ \] T-2 theirs/)
  assert.match(text, /- \[ \] T-3 mine/)
  assert.match(text, /<!-- next: 4 -->/)
  assert.deepEqual(renames, [["T-2", "T-3"]])
  assert.doesNotMatch(text, /<<<<<<<|>>>>>>>/)
})

test("merge: a close on one side and an edit on the other keeps both", () => {
  const base = open(2, ["- [ ] T-1 draft the email"])
  const ours = open(2, ["- [x] T-1 draft the email (closed 2026-11-23, abc12345, sent)"])
  const theirs = open(2, ["- [ ] T-1 draft the holiday email @waiting:Ana"])
  const { text } = mergeOpenText(base, ours, theirs)
  assert.match(text, /- \[x\] T-1 draft the holiday email @waiting:Ana \(closed 2026-11-23, abc12345, sent\)/)
})

test("merge: text edited on both sides keeps theirs and ours as an also: line", () => {
  const base = open(2, ["- [ ] T-1 a"])
  const { text } = mergeOpenText(base, open(2, ["- [ ] T-1 b"]), open(2, ["- [ ] T-1 c"]))
  assert.match(text, /- \[ \] T-1 c\n  also: b/)
})

test("merge: closed beats open when both sides changed state", () => {
  const base = open(2, ["- [ ] T-1 a"])
  const { text } = mergeOpenText(base, open(2, ["- [ ] T-1 a @waiting:Bo"]), open(2, ["- [x] T-1 a (closed 2026-11-20)"]))
  assert.match(text, /- \[x\] T-1 a @waiting:Bo \(closed 2026-11-20\)/)
})

test("merge: decisions renumber, and a supersede that points at a renumbered one follows it", () => {
  const head = "# Decisions: T\n<!-- managed by ws; change with `ws decide` -->\n"
  const base = `${head}<!-- next: 2 -->\n\n- [active] T-D1 old (2026-11-01)\n`
  const ours = `${head}<!-- next: 3 -->\n\n- [active] T-D2 mine (2026-11-23)\n\n## Superseded\n\n- [superseded by T-D2] T-D1 old (2026-11-01)\n`
  const theirs = `${head}<!-- next: 3 -->\n\n- [active] T-D1 old (2026-11-01)\n- [active] T-D2 theirs (2026-11-23)\n`
  const { text, renames } = mergeDecisionsText(base, ours, theirs)
  assert.deepEqual(renames, [["T-D2", "T-D3"]])
  assert.match(text, /- \[active\] T-D2 theirs/)
  assert.match(text, /- \[active\] T-D3 mine/)
  assert.match(text, /- \[superseded by T-D3\] T-D1 old/)
})

test("merge: WORKSTREAM.md takes one-sided field changes and unions sources", () => {
  const base = "---\nid: t\nstatus: active\nsources: []\n---\n\nBrief.\n"
  const ours = "---\nid: t\nstatus: waiting\nwaiting_on: Ana\nsources:\n  - path: ~/a.md\n---\n\nBrief.\n"
  const theirs = "---\nid: t\nstatus: active\ntitle: New title\nsources:\n  - path: ~/b.md\n---\n\nBrief, longer.\n"
  const { text } = mergeWorkstreamText(base, ours, theirs)
  assert.match(text, /status: waiting/)
  assert.match(text, /waiting_on: Ana/)
  assert.match(text, /title: New title/)
  assert.match(text, /path: ~\/a\.md[\s\S]*path: ~\/b\.md/)
  assert.match(text, /Brief, longer\./)
})

test("merge: a file with lines ws can't read is refused, not rewritten", () => {
  assert.throws(() => mergeOpenText("", open(1, ["* [ ] T-1 hand edit"]), open(1, [])), /can't read/)
})

// ------------------------------------------------------------- two machines

test("two machines converge after concurrent adds, closes and decisions", async () => {
  const remote = await bare("conv")
  const a = await machine("conv-a", { remote })
  const b = await machine("conv-b", { remote })
  a.okWs("new", "proj", "--title", "Project", "--cwd", proj, "--prefix", "PR")
  a.okWs("item", "add", "proj", "first")
  assert.match(a.okWs("sync"), /main: pushed/)
  assert.match(b.okWs("sync"), /main: (up-to-date|pushed)/)
  assert.match(b.okWs("show", "proj"), /PR-1\s+first/)

  // Both work offline from each other, then sync.
  a.okWs("item", "add", "proj", "from a")
  a.okWs("decide", "proj", "use git", "--why", "plain files")
  b.okWs("item", "add", "proj", "from b")
  b.okWs("item", "close", "proj", "PR-1", "--note", "done on b")
  a.okWs("log", "proj", "a did things")
  b.okWs("log", "proj", "b did things")
  a.okWs("sync")
  const sb = b.okWs("sync")
  assert.match(sb, /renumbered proj: PR-2 -> PR-3/)
  assert.doesNotMatch(b.okWs("sync"), /renumbered/, "a renumbering is reported once")
  a.okWs("sync")

  const [oa, ob] = [await a.read("ws/proj/open.md"), await b.read("ws/proj/open.md")]
  assert.equal(oa, ob)
  assert.doesNotMatch(oa, /<<<<<<<|=======|>>>>>>>/)
  assert.match(oa, /- \[ \] PR-2 from a/)
  assert.match(oa, /- \[ \] PR-3 from b/)
  assert.match(oa, /- \[x\] PR-1 first/)
  assert.match(oa, /<!-- next: 4 -->/)
  assert.equal(await a.read("ws/proj/decisions.md"), await b.read("ws/proj/decisions.md"))
  const logs = (await fs.readdir(path.join(a.root, "ws/proj/log"))).length
  assert.equal(logs, 2)
  // Each log says which machine wrote it.
  const texts = await Promise.all((await fs.readdir(path.join(b.root, "ws/proj/log"))).map((f) => fs.readFile(path.join(b.root, "ws/proj/log", f), "utf-8")))
  assert.deepEqual(texts.map((t) => t.match(/host: (\S+)/)?.[1]).sort(), ["conv-a", "conv-b"])
  // A new item after the merge gets a fresh ID on both.
  b.okWs("item", "add", "proj", "after")
  b.okWs("sync"); a.okWs("sync")
  assert.match(await a.read("ws/proj/open.md"), /PR-4 after/)
})

test("config.json, the queue and locks never leave the machine", async () => {
  const remote = await bare("private")
  const a = await machine("priv-a", { remote, machine: "laptop" }, { llm: { url: "http://127.0.0.1:9/v1" } })
  a.okWs("new", "p", "--title", "P", "--cwd", proj)
  await fs.mkdir(path.join(a.root, "queue"), { recursive: true })
  await fs.writeFile(path.join(a.root, "queue", "job.json"), "{}")
  a.okWs("sync")
  const tracked = git(a.root, "ls-files").out.split("\n")
  assert.ok(tracked.includes("ws/p/open.md"))
  assert.ok(!tracked.some((f) => f === "config.json" || f.startsWith("queue/") || f.includes(".lock")), tracked.join(", "))
})

test("offline: changes are committed locally and pushed once the remote is back", async () => {
  const remote = await bare("offline")
  const a = await machine("off-a", { remote })
  a.okWs("new", "o", "--title", "O", "--cwd", proj)
  a.okWs("sync")
  const away = remote + ".away"
  await fs.rename(remote, away)
  a.okWs("item", "add", "o", "written offline")
  const r = a.okWs("sync")
  assert.match(r, /main: offline/)
  assert.equal(git(a.root, "status", "--porcelain").out.trim(), "")
  await fs.rename(away, remote)
  assert.match(a.okWs("sync"), /main: pushed/)
  const b = await machine("off-b", { remote })
  b.okWs("sync")
  assert.match(b.okWs("show", "o"), /written offline/)
})

test("a clone without the merge driver registers it before merging", async () => {
  const remote = await bare("driver")
  const a = await machine("drv-a", { remote })
  const b = await machine("drv-b", { remote })
  a.okWs("new", "d", "--title", "D", "--cwd", proj, "--prefix", "D")
  a.okWs("sync"); b.okWs("sync")
  git(b.root, "config", "--unset", "merge.ws.driver")
  a.okWs("item", "add", "d", "on a")
  b.okWs("item", "add", "d", "on b")
  a.okWs("sync")
  b.okWs("sync")
  assert.match(git(b.root, "config", "merge.ws.driver").out, /merge-driver/)
  const text = await b.read("ws/d/open.md")
  assert.match(text, /D-1 on a/)
  assert.match(text, /D-2 on b/)
})

test("a sync killed mid-merge is undone and redone; a conflict elsewhere stops without damage", async () => {
  const remote = await bare("killed")
  const a = await machine("kill-a", { remote })
  const b = await machine("kill-b", { remote })
  a.okWs("new", "k", "--title", "K", "--cwd", proj, "--prefix", "K")
  a.okWs("sync"); b.okWs("sync")
  // The same non-record file edited on both sides: git can't merge it.
  await fs.writeFile(path.join(a.root, "notes.txt"), "a\n")
  await fs.writeFile(path.join(b.root, "notes.txt"), "b\n")
  a.okWs("item", "add", "k", "from a")
  a.okWs("sync")
  b.okWs("item", "add", "k", "from b")
  const r = b.ws("sync")
  assert.notEqual(r.code, 0)
  assert.match(r.out, /main: conflict \(couldn't merge notes\.txt\)/)
  assert.ok(!existsSync(path.join(b.root, ".git", "MERGE_HEAD")), "merge was aborted")
  const ob = await b.read("ws/k/open.md")
  assert.match(ob, /K-1 from b/)
  assert.doesNotMatch(ob, /<<<<<<<|>>>>>>>/)
  // The next session start says sync has stopped (background syncs are quiet).
  const hook = spawnSync(process.execPath, [BIN, "hook", "claude", "start"], { input: JSON.stringify({ session_id: "s1", cwd: tmp }), encoding: "utf-8", env: { ...process.env, ...gitEnv, WS_ROOT: b.root, WS_NO_SPAWN: "1" } })
  assert.match(hook.stdout, /Sync between machines has stopped/)
  assert.match(hook.stdout, /notes\.txt/)

  // Simulate a sync that died mid-merge: a merge left in progress.
  await fs.writeFile(path.join(b.root, "notes.txt"), "a\n")
  git(b.root, "add", "-A"); git(b.root, "commit", "-qm", "resolve by hand")
  git(b.root, "fetch", "-q", "origin")
  await fs.writeFile(path.join(b.root, ".git", "MERGE_HEAD"), git(b.root, "rev-parse", "origin/main").out.trim() + "\n")
  const r2 = b.ws("sync")
  assert.equal(r2.code, 0, r2.out)
  a.okWs("sync")
  assert.equal(await a.read("ws/k/open.md"), await b.read("ws/k/open.md"))
  const hook2 = spawnSync(process.execPath, [BIN, "hook", "claude", "start"], { input: JSON.stringify({ session_id: "s2", cwd: tmp }), encoding: "utf-8", env: { ...process.env, ...gitEnv, WS_ROOT: b.root, WS_NO_SPAWN: "1" } })
  assert.doesNotMatch(hook2.stdout, /stopped/, "the warning clears once a sync succeeds")
  assert.match(await a.read("ws/k/open.md"), /K-1 from a[\s\S]*K-2 from b/)
})

test("shares: matching workstreams live in their own repo, and a share-only machine sees only them", async () => {
  const mainRemote = await bare("share-main")
  const clinicRemote = await bare("share-clinic")
  const shares = [{ name: "clinic", match: ["clinic-*", "billing"], remote: clinicRemote }]
  const laptop = await machine("sh-laptop", { remote: mainRemote, shares })
  laptop.okWs("new", "clinic-app", "--title", "Clinic app", "--cwd", proj)
  laptop.okWs("new", "billing", "--title", "Billing", "--cwd", proj)
  laptop.okWs("new", "client-x", "--title", "Client X", "--cwd", proj)
  assert.ok(existsSync(path.join(laptop.root, "shares/clinic/ws/clinic-app/WORKSTREAM.md")))
  assert.ok(!existsSync(path.join(laptop.root, "ws/clinic-app")))
  const sync = laptop.okWs("sync")
  assert.match(sync, /main: pushed/)
  assert.match(sync, /clinic: pushed/)
  assert.ok(!git(laptop.root, "ls-files").out.includes("clinic-app"), "the main repo holds no share data")

  const share = await machine("sh-share-only", { shares })
  share.okWs("sync")
  const ls = share.okWs("ls")
  assert.match(ls, /clinic-app/)
  assert.match(ls, /billing/)
  assert.doesNotMatch(ls, /client-x/)
  share.okWs("item", "add", "clinic-app", "from the share-only machine")
  share.okWs("sync")
  laptop.okWs("sync")
  assert.match(laptop.okWs("show", "clinic-app"), /from the share-only machine/)
  assert.match(share.okWs("sync"), /main: local/)
})

test("paths: a stored path maps to this machine's folder and back", async () => {
  const here = path.join(tmp, "elsewhere", "proj")
  await fs.mkdir(here, { recursive: true })
  const root = path.join(tmp, "paths-m")
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ sync: { machine: "server", shares: [] }, paths: { "~/Desktop/proj": here } }))
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const s = await import(${JSON.stringify(STORE)}); console.log(JSON.stringify([s.expand("~/Desktop/proj/a.md"), s.tildify(${JSON.stringify(path.join(here, "b.md"))}), s.expand("~/Desktop/project2")]))`],
  { encoding: "utf-8", env: { ...process.env, WS_ROOT: root } })
  const [inPath, outPath, other] = JSON.parse(r.stdout)
  assert.equal(inPath, path.join(here, "a.md"))
  assert.equal(outPath, "~/Desktop/proj/b.md")
  assert.equal(other, path.join(os.homedir(), "Desktop/project2"), "only whole path segments match")
})

test("compose lists sources from another machine instead of failing", async () => {
  const remote = await bare("compose")
  const a = await machine("cmp-a", { remote })
  const otherMachine = path.join(tmp, "not-here", "deep")
  a.okWs("new", "c", "--title", "C", "--cwd", proj)
  a.okWs("set", "c", `cwd=${path.join(otherMachine, "proj")}`)
  const wsFile = path.join(a.root, "ws/c/WORKSTREAM.md")
  await fs.writeFile(wsFile, (await fs.readFile(wsFile, "utf-8")).replace("sources: []", `sources:\n  - path: ${path.join(otherMachine, "STATUS.md")}\n    role: status`))
  const out = a.okWs("prompt", "c", "--no-copy")
  assert.match(out, /Not on this machine \(cmp-a\), so skipped:/)
  assert.match(out, /STATUS\.md \(status\)/)
  assert.match(out, /the project folder/)
})

test("sync is off until config.json sets it up, and hooks honour WS_CAPTURE=0", async () => {
  const root = path.join(tmp, "plain")
  await fs.mkdir(root, { recursive: true })
  const r = spawnSync(process.execPath, [BIN, "sync"], { encoding: "utf-8", env: { ...process.env, WS_ROOT: root } })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /isn't set up/)
  assert.ok(!existsSync(path.join(root, ".git")))
  const q = spawnSync(process.execPath, [BIN, "sync", "--quiet"], { encoding: "utf-8", env: { ...process.env, WS_ROOT: root } })
  assert.equal(q.status, 0)
})

test("a data folder with its own history and .gitignore joins without conflicts", async () => {
  const remote = await bare("history")
  const a = await machine("hist-a", { remote })
  // The first machine's folder was already a git repo with a hand-written .gitignore.
  git(a.root, "init", "-q", "-b", "main")
  await fs.writeFile(path.join(a.root, ".gitignore"), "*.lock/\nhook-errors.log\n.trash/\n")
  await fs.writeFile(path.join(a.root, "ignore.txt"), "/tmp/a\n")
  git(a.root, "add", "-A"); git(a.root, "commit", "-qm", "old history")
  a.okWs("new", "h", "--title", "H", "--cwd", proj)
  a.okWs("sync")
  // A second machine that already has data of its own, and its own ignore list.
  const b = await machine("hist-b", { remote })
  await fs.writeFile(path.join(b.root, "ignore.txt"), "/tmp/b\n")
  b.okWs("new", "only-b", "--title", "Only B", "--cwd", proj)
  const r = b.ws("sync")
  assert.equal(r.code, 0, r.out)
  a.okWs("sync")
  for (const m of [a, b]) {
    const ls = m.okWs("ls")
    assert.match(ls, /\bh\b/); assert.match(ls, /only-b/)
    assert.match(await m.read("ignore.txt"), /\/tmp\/a[\s\S]*\/tmp\/b|\/tmp\/b[\s\S]*\/tmp\/a/)
  }
  assert.equal(await a.read(".gitignore"), await b.read(".gitignore"))
})

// ------------------------------------------------------------ the remote is data only

// Push a commit to `remote` made by plain git (as another, misbehaving machine could), on top
// of what is there. `files` maps path -> text, or { link: target } for a symlink.
async function pushRaw(remote, name, files) {
  const dir = path.join(tmp, `raw-${name}`)
  git(tmp, "clone", "-q", remote, dir)
  for (const [rel, v] of Object.entries(files)) {
    const f = path.join(dir, rel)
    await fs.mkdir(path.dirname(f), { recursive: true })
    if (v && typeof v === "object" && "index" in v) continue // added below, straight into the index
    await fs.rm(f, { force: true })
    if (typeof v === "string") await fs.writeFile(f, v)
    else await fs.symlink(v.link, f)
  }
  git(dir, "add", "-A", "-f")
  // { index: text }: a path written into git's index directly, as a case-sensitive machine
  // would have it, whatever this machine's disk does with case.
  for (const [rel, v] of Object.entries(files)) {
    if (!(v && typeof v === "object" && "index" in v)) continue
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: v.index, encoding: "utf-8" }).stdout.trim()
    assert.equal(git(dir, "update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`).code, 0)
  }
  assert.equal(git(dir, "commit", "-qm", "raw").code, 0)
  assert.equal(git(dir, "push", "-q", "origin", "HEAD:main").code, 0)
}

test("front matter must be YAML: code in it is never run, locally or from a merge", async () => {
  const mark = path.join(tmp, "ran-code")
  const evil = `---js\n{ x: require("fs").writeFileSync(${JSON.stringify(mark)}, "1") }\n---\n\nbrief\n`
  assert.throws(() => mergeWorkstreamText("", evil, ""), /plain YAML|bare "---"/)
  assert.throws(() => mergeWorkstreamText("", "---\nid: a\n---\n", evil), /plain YAML|bare "---"/)
  const remote = await bare("yamlonly")
  const a = await machine("yaml-a", { remote })
  a.okWs("new", "y", "--title", "Y", "--cwd", proj)
  a.okWs("sync")
  await pushRaw(remote, "yaml", { "ws/y/WORKSTREAM.md": evil })
  a.ws("sync")
  a.ws("ls"); a.ws("show", "y")
  const hook = spawnSync(process.execPath, [BIN, "hook", "claude", "start"], { input: JSON.stringify({ session_id: "s", cwd: proj }), encoding: "utf-8", env: { ...process.env, ...gitEnv, WS_ROOT: a.root, WS_NO_SPAWN: "1" } })
  assert.equal(hook.status, 0)
  assert.ok(!existsSync(mark), "front-matter code ran")
  // A body that looks like code front matter is kept as text when the file is written back.
  await pushRaw(remote, "yaml2", { "ws/y/WORKSTREAM.md": `---\nid: y\ntitle: Y\nstatus: active\n---\n${evil}` })
  a.ws("sync")
  a.ws("set", "y", "status=waiting")
  a.ws("item", "add", "y", "after")
  assert.ok(!existsSync(mark), "code in a body ran on write")
})

test("incoming symlinks, machine-local files and un-ignore rules are refused before merging", async () => {
  const outside = path.join(tmp, "outside-target.txt")
  await fs.writeFile(outside, "keep me\n")
  for (const [name, files, why] of [
    ["link", { "ws/l/open.md": { link: outside } }, /symlink/],
    ["state", { ".sync-state.json": { link: outside } }, /symlink/],
    ["config", { "config.json": JSON.stringify({ llm: { url: "http://example.invalid/v1" } }) }, /settings/],
    ["unignore", { ".gitignore": "!config.json\n" }, /un-ignores/],
    ["attrs", { "ws/x/.gitattributes": "* merge=union\n" }, /git metadata/],
    ["case-config", { "Config.JSON": { index: "{}" } }, /settings/],
    ["case-queue", { "Queue/job.json": { index: "{}" } }, /queue/],
    ["case-attrs", { ".GitAttributes": { index: "* merge=union\n" } }, /case variant/],
    ["collide", { "ws/l/Open.md": { index: "x\n" } }, /differ only in case/],
    ["big-attrs", { ".gitattributes": "# pad\n".repeat(20000) + "* merge=union\n" }, /too large|sets/],
  ]) {
    const remote = await bare(`refuse-${name}`)
    const a = await machine(`ref-${name}`, { remote })
    a.okWs("new", "l", "--title", "L", "--cwd", proj, "--prefix", "L")
    a.okWs("sync")
    const before = await a.read("config.json")
    await pushRaw(remote, name, files)
    a.okWs("item", "add", "l", "local item")
    const r = a.ws("sync")
    assert.notEqual(r.code, 0, `${name}: ${r.out}`)
    assert.match(r.out, /main: refused/)
    assert.match(r.out, why)
    assert.equal(await a.read("config.json"), before, `${name}: local config.json changed`)
    assert.equal(await fs.readFile(outside, "utf-8"), "keep me\n", `${name}: wrote outside the data folder`)
    assert.ok(!(await fs.lstat(path.join(a.root, "ws/l/open.md"))).isSymbolicLink())
    assert.match(await a.read("ws/l/open.md"), /L-1 local item/)
  }
})

test("this machine's own files never go out, whatever .gitignore says", async () => {
  const remote = await bare("outgoing")
  const a = await machine("out-a", { remote })
  a.okWs("new", "o", "--title", "O", "--cwd", proj)
  a.okWs("sync")
  await fs.appendFile(path.join(a.root, ".gitignore"), "!config.json\n!queue/\n")
  await fs.mkdir(path.join(a.root, "queue"), { recursive: true })
  await fs.writeFile(path.join(a.root, "queue", "j.json"), "{}")
  await fs.symlink(path.join(tmp, "outside-target.txt"), path.join(a.root, "a-link"))
  a.okWs("item", "add", "o", "x")
  a.okWs("sync")
  const pushed = git(tmp, "--git-dir", remote, "ls-tree", "-r", "--name-only", "main").out.split("\n")
  assert.ok(pushed.includes("ws/o/open.md"))
  for (const f of ["config.json", "queue/j.json", "a-link"]) assert.ok(!pushed.includes(f), `${f} was pushed`)
})

test("a merge that can't be undone stops sync; nothing half-merged is committed or pushed", async () => {
  const remote = await bare("stuck")
  const a = await machine("stuck-a", { remote })
  const b = await machine("stuck-b", { remote })
  a.okWs("new", "s", "--title", "S", "--cwd", proj)
  a.okWs("sync"); b.okWs("sync")
  await fs.writeFile(path.join(a.root, "notes.txt"), "a\n"); a.okWs("sync")
  await fs.writeFile(path.join(b.root, "notes.txt"), "b\n")
  git(b.root, "add", "-A"); git(b.root, "commit", "-qm", "b notes")
  git(b.root, "fetch", "-q", "origin")
  git(b.root, "merge", "-q", "origin/main") // conflicts on notes.txt
  await fs.rm(path.join(b.root, ".git", "MERGE_HEAD")) // git merge --abort can no longer undo it
  b.okWs("item", "add", "s", "written meanwhile")
  const headBefore = git(tmp, "--git-dir", remote, "rev-parse", "main").out.trim()
  const r = b.ws("sync")
  assert.notEqual(r.code, 0)
  assert.match(r.out, /couldn't undo a failed merge|unfinished/)
  const pushed = git(tmp, "--git-dir", remote, "show", "main:notes.txt").out
  assert.doesNotMatch(pushed, /<<<<<<<|>>>>>>>/)
  assert.equal(git(tmp, "--git-dir", remote, "rev-parse", "main").out.trim(), headBefore, "nothing new was pushed")
  assert.match(git(b.root, "status", "--porcelain").out, /notes\.txt/, "the stuck merge is left for a person, not committed")
})

test("a workstream set at the home folder (or above) never claims sessions", () => {
  const list = [
    { id: "home", cwd: os.homedir(), status: "active" },
    { id: "root", cwd: "/", status: "active" },
  ]
  assert.equal(matchWorkstream(list, path.join(os.homedir(), "anything"), undefined).link, null)
})

test("a data folder's own earlier history never goes to the remote", async () => {
  const remote = await bare("fresh")
  const a = await machine("fresh-a", { remote })
  git(a.root, "init", "-q", "-b", "main")
  await fs.writeFile(path.join(a.root, "config.json.old"), "old settings\n")
  git(a.root, "add", "-A"); git(a.root, "commit", "-qm", "an old commit")
  await fs.rm(path.join(a.root, "config.json.old"))
  git(a.root, "add", "-A"); git(a.root, "commit", "-qm", "removed it")
  a.okWs("new", "f", "--title", "F", "--cwd", proj)
  a.okWs("sync")
  const log = git(tmp, "--git-dir", remote, "log", "--format=%s", "main").out.trim().split("\n")
  assert.equal(log.length, 1, log.join(" | "))
  assert.equal(git(tmp, "--git-dir", remote, "log", "--all", "--format=%H", "--", "config.json.old").out.trim(), "")
  assert.match(git(a.root, "for-each-ref", "refs/ws/").out, /pre-sync/, "the old history is kept locally")
})

test("merge: records with a duplicated ID are left for a person", () => {
  assert.throws(() => mergeOpenText(open(2, ["- [ ] T-1 a"]), open(2, ["- [ ] T-1 a", "- [ ] T-1 b"]), open(2, ["- [ ] T-1 a"])), /appears twice/)
})
