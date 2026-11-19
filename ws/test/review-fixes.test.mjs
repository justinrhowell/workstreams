// Regression tests for the 2026-11 code review: secrets in Codex tool calls, one broken
// workstream disabling the hooks for all of them, and a relative cwd claiming every session.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-review-")
process.env.WS_ROOT = path.join(tmp, "root")
process.env.WS_NO_SPAWN = "1"
const store = await import("../lib/store.mjs")
const cap = await import("../lib/capture.mjs")
const sum = await import("../lib/summarize.mjs")

const BIN = fileURLToPath(new URL("../bin/ws.mjs", import.meta.url))
const env = { ...process.env, WS_ROOT: process.env.WS_ROOT }
const ws = (args, cwd = tmp) => spawnSync(process.execPath, [BIN, ...args], { env, cwd, encoding: "utf-8" })
const hookStart = (cwd) => spawnSync(process.execPath, [BIN, "hook", "claude", "start"], {
  env, cwd, encoding: "utf-8", input: JSON.stringify({ session_id: "s-" + Math.random(), cwd }),
})
const folder = async (name) => { const d = path.join(tmp, name); await fs.mkdir(d, { recursive: true }); return d }

test("redaction: credential-named variables, whatever the value looks like", () => {
  const out = sum.redact([
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "SECRET_KEY=abcd1234efgh5678 JWT_SECRET_KEY=zzzzyyyy PGPASSWORD=hunter PASSWORD=onlyletters",
  ].join("\n"))
  for (const leaked of ["wJalrXUtnFEMI", "abcd1234efgh5678", "zzzzyyyy", "hunter", "onlyletters"]) assert.ok(!out.includes(leaked), leaked)
})

test("redaction: JSON-escaped quotes (Codex tool arguments)", () => {
  const out = sum.redact(String.raw`{"cmd":"export DB_PASSWORD=\"s3cretpass1\" api_token=\"abc123def456ghi\""}`)
  for (const leaked of ["s3cretpass1", "abc123def456ghi"]) assert.ok(!out.includes(leaked), leaked)
})

test("redaction: provider key formats and credentials in command flags", () => {
  const secrets = {
    stripe: "sk_live_51Habc123DEF456ghi789",
    google: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    gitlab: "glpat-abcdefghij0123456789",
    npm: "npm_abcdefghijklmnopqrstuvwxyz0123456789",
  }
  const out = sum.redact([
    ...Object.values(secrets),
    "mysql -u root -pMyPass db", "curl -u admin:letmein https://x", "docker login --password hunter2x",
  ].join("\n"))
  for (const leaked of [...Object.values(secrets), "MyPass", "letmein", "hunter2x"]) assert.ok(!out.includes(leaked), leaked)
})

test("redaction: everyday commands and prose stay as they are", () => {
  for (const text of ["git push -u origin main", "mkdir -p src/lib", "Decided to rotate the API_KEY tomorrow", "Fix token: refresh bug in auth"]) {
    assert.equal(sum.redact(text), text)
  }
})

test("Codex tool calls: arguments are decoded, then redacted", async () => {
  const t = path.join(tmp, "codex.jsonl")
  const rows = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Set up the database" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", 'export DB_PASSWORD="s3cretpass1" && psql'] }) } },
  ]
  await fs.writeFile(t, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const digest = await sum.digestTranscript("codex", t)
    assert.ok(!digest.includes("s3cretpass1"), digest)
  assert.match(digest, /TOOL: shell\(bash -lc export DB_PASSWORD="\[redacted\]"/)
})

test("one unreadable workstream doesn't hide the others", async () => {
  const good = await folder("good")
  await store.createWorkstream("good", { title: "Good", cwd: good })
  await store.addItem("good", "Fix nav")
  await store.createWorkstream("bad", { title: "Bad", cwd: await folder("bad") })
  const file = path.join(store.ROOT, "ws", "bad", "WORKSTREAM.md")
  await fs.writeFile(file, (await fs.readFile(file, "utf-8")).replace(/^title: .*$/m, "title: Bad: phase 2"))
  await fs.mkdir(path.join(store.ROOT, "ws", "Old_Copy"), { recursive: true })
  await fs.copyFile(path.join(store.ROOT, "ws", "good", "WORKSTREAM.md"), path.join(store.ROOT, "ws", "Old_Copy", "WORKSTREAM.md"))

  const broken = []
  const list = await store.listWorkstreams({ broken })
  assert.deepEqual(list.map((w) => w.id), ["good"])
  assert.deepEqual(broken.map((b) => b.id).sort(), ["Old_Copy", "bad"])

  const start = hookStart(good)
  assert.equal(start.status, 0)
  assert.match(start.stdout, /belongs to workstream \\"good\\"[\s\S]*Fix nav/)

  const ls = ws(["ls"])
  assert.equal(ls.status, 0, ls.stderr)
  assert.match(ls.stdout, /good/)
  assert.match(ls.stderr, /✗ bad: .*skipped/)

  const doctor = ws(["doctor"])
  assert.equal(doctor.status, 1)
  assert.match(doctor.stdout, /✗ bad\n {4}error:/)
  assert.match(doctor.stdout, /✓ good/)

  await fs.rm(path.join(store.ROOT, "ws", "bad"), { recursive: true })
  await fs.rm(path.join(store.ROOT, "ws", "Old_Copy"), { recursive: true })
})

test("ws set cwd=. stores an absolute folder", async () => {
  const proj = await folder("proj")
  await store.createWorkstream("rel", { title: "Rel", cwd: proj })
  const r = ws(["set", "rel", "cwd=."], proj)
  assert.equal(r.status, 0, r.stderr)
  const w = await store.getWorkstream("rel")
  assert.equal(await fs.realpath(w.cwd), await fs.realpath(proj))
  assert.equal(hookStart(await folder("elsewhere")).stdout, "")
})

test("a relative cwd already on disk never claims a session", async () => {
  await store.createWorkstream("legacy", { title: "Legacy", cwd: await folder("legacy") })
  await store.updateWorkstream("legacy", { cwd: "." })
  const elsewhere = await folder("elsewhere2")
  assert.equal(cap.matchWorkstream(await store.listWorkstreams(), elsewhere, null).link, null)
  assert.equal(hookStart(elsewhere).stdout, "")
  const doctor = ws(["doctor", "legacy"])
  assert.match(doctor.stdout, /cwd must be an absolute folder/)
})

test("redaction: quoted credential values are redacted through the closing quote", () => {
  const cases = [
    [`export DB_PASSWORD="alpha beta123"`, `export DB_PASSWORD="[redacted]"`],
    [`DB_PASSWORD='a,b;c\\d'`, `DB_PASSWORD='[redacted]'`],
    [String.raw`{"cmd":"export DB_PASSWORD=\"two words9\""}`, String.raw`{"cmd":"export DB_PASSWORD=\"[redacted]\""}`],
    [`docker login --password "two words9"`, `docker login --password "[redacted]"`],
    [`password="alpha beta123"`, `password="[redacted]"`],
    [`DB_PASSWORD=abc`, `DB_PASSWORD=[redacted]`],
    [`mysql -u app -p'SafePass42' db`, `mysql -u app -p'[redacted]' db`],
    [`mysql -u app -p"Safe Pass42" db`, `mysql -u app -p"[redacted]" db`],
    [`mysql -u app -pSafePass42 db`, `mysql -u app -p[redacted] db`],
  ]
  for (const [text, want] of cases) assert.equal(sum.redact(text), want)
  // Quoted prose after a token-type key still survives.
  for (const text of [`token: "upgrade to v2 next week"`, `set token="" before retrying`]) assert.equal(sum.redact(text), text)
})

test("a workstream folder that can't be read is reported, not silently skipped", { skip: process.getuid?.() === 0 }, async () => {
  const good = await folder("good2")
  await store.createWorkstream("good2", { title: "Good", cwd: good })
  await store.createWorkstream("locked", { title: "Locked", cwd: await folder("locked") })
  const dir = path.join(store.ROOT, "ws", "locked")
  await fs.chmod(dir, 0o000)
  try {
    const broken = []
    const list = await store.listWorkstreams({ broken })
    assert.ok(list.some((w) => w.id === "good2"))
    assert.deepEqual(broken.map((b) => b.id), ["locked"])
    assert.match(broken[0].error, /can't read WORKSTREAM\.md \(EACCES\)/)
  } finally {
    await fs.chmod(dir, 0o755)
    await fs.rm(dir, { recursive: true })
  }
})
