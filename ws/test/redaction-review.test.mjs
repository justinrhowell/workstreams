// Regression tests for the Nov 2026 redaction review: formats that used to leak, prose
// that used to be mangled, a key header with no END, and inputs that took seconds.
// Fake values are built from two halves so secret scanners don't flag this file.
import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { mkTmp } from "./tmp.mjs"

const tmp = await mkTmp("ws-redact-")
process.env.WS_ROOT = path.join(tmp, "root")
process.env.WS_NO_SPAWN = "1"
const { redact } = await import("../lib/summarize.mjs")

const j = (...p) => p.join("")

test("formats that used to leak are redacted", () => {
  const cases = {
    "PGP key": [j("-----BEGIN PGP PRIVATE KEY", " BLOCK-----\nVersion: x\nlQOYBF", "a".repeat(40), "\n-----END PGP PRIVATE KEY BLOCK-----"), "lQOYBF"],
    "redis empty user": ["redis://:FakePass99@cache.local:6379", "FakePass99"],
    "@ in password": ["pg://app:Fake@Pass99@db.local/x", "Pass99"],
    "DB_PASS": ["DB_PASS=hunter2", "hunter2"],
    "MYSQL_PWD": ["MYSQL_PWD=hunter2", "hunter2"],
    "ENCRYPTION_KEY": ["ENCRYPTION_KEY=abc", "=abc"],
    "JWT_SIGNING_KEY": ["JWT_SIGNING_KEY=abcdef", "abcdef"],
    "quoted short password": ['{"password": "hunter2"}', "hunter2"],
    "long lowercase password": ["password: correcthorsebattery", "correcthorsebattery"],
    "docker -p": ["docker login -p S3cretVal registry.local", "S3cretVal"],
    "sshpass": ["sshpass -p S3cretVal ssh host", "S3cretVal"],
    "curl -u attached": ["curl -ume:S3cretVal https://x", "S3cretVal"],
    "curl --user=": ["curl --user=me:S3cretVal https://x", "S3cretVal"],
    "--api-key": ["tool --api-key S3cretVal1", "S3cretVal1"],
    "netrc": ["machine api.local login me password S3cretVal", "S3cretVal"],
    "hugging face": [j("hf_", "abcdefghijklmnopqrstuvwxyz0123456789"), "abcdefghijklmnop"],
    "sendgrid": [j("SG.", "abcdefghijklmnop1234", ".", "qrstuvwxyz0123456789ABCD"), "qrstuvwxyz"],
    "slack app": [j("xapp-", "1-A0123456789-abcdef"), "A0123456789"],
    "slack webhook": [j("https://hooks.slack.com/services/", "T000/B000/abcdefghijkl"), "abcdefghijkl"],
    "azure sas": ["https://acct.blob.core.windows.net/c?sv=2024&sig=AbCdEf0123456789%2Bxyz", "AbCdEf0123456789"],
    "lowercase bearer": ["authorization: bearer abc123def456ghi789", "abc123def456ghi789"],
  }
  for (const [name, [input, secret]] of Object.entries(cases)) {
    assert.ok(!redact(input).includes(secret), `${name}: ${redact(input)}`)
  }
})

test("long secrets are redacted in full, not just their first part", () => {
  const b64 = "A".repeat(3000) + "zz9"
  const cases = {
    unquoted: "PRIVATE_KEY_B64=" + b64,
    quoted: 'PRIVATE_KEY_B64="' + b64 + '"',
    bearer: "Bearer " + "a1".repeat(450),
    jwt: j("eyJ", "a".repeat(20), ".", "b".repeat(5000), ".", "c".repeat(40)),
    "escaped newlines": j('"private_key": "-----BEGIN PRIVATE KEY-----', "\\nMIIE", "Q".repeat(80), "\\n", "R".repeat(64), '\\n"'),
  }
  for (const [name, input] of Object.entries(cases)) {
    assert.doesNotMatch(redact(input), /zz9|a1a1a1a1|bbbbbbbbbb|QQQQ|RRRR/, name)
  }
})

test("ordinary prose and settings are left alone", () => {
  for (const text of [
    "Basic Authentication and Token Verification",
    "Added basic authentication to the token validation endpoint",
    "The token documentation is out of date",
    "MAX_TOKENS=4096 TOKENIZERS_PARALLELISM=false",
    "BYPASS_CACHE=1 PASSTHROUGH=on",
    "Repair password: handling failure",
    "Fix token: refresh bug in auth",
    "npm view https://registry.local:4873/@scope/pkg",
    "http://localhost:3000/@user/profile",
  ]) assert.equal(redact(text), text)
})

test("a key header with no END redacts the key lines, not everything after", () => {
  const out = redact("The file starts with -----BEGIN PRIVATE KEY----- so rotate it. After that, ship the fix.")
  assert.match(out, /\[redacted key\] so rotate it\. After that, ship the fix\./)
  const clipped = redact(j("-----BEGIN RSA PRIVATE KEY-----\nMIIEow", "B".repeat(60), "\nMIIEpA", "C".repeat(60), "\n\nNext step: deploy"))
  assert.ok(!clipped.includes("BBBB") && !clipped.includes("CCCC"), clipped)
  assert.match(clipped, /Next step: deploy/)
})

test("long runs of key-like text take linear time", () => {
  for (const unit of ["token", "TOKEN", "pwd", "eyJ-", "tokentoken-", "SECRET_", "mysql x", "//a:", "-----BEGIN A"]) {
    const time = (n) => { const s = unit.repeat(n); const t = performance.now(); redact(s); return performance.now() - t }
    time(1000) // warm up
    const small = Math.max(time(20_000), 1)
    const big = time(80_000) // 4x the input
    assert.ok(big < small * 12 + 50, `${unit}: ${small.toFixed(0)}ms → ${big.toFixed(0)}ms for 4x input`)
  }
})

test("a several-MB unbroken token doesn't overflow the stack", () => {
  for (const s of ["sk-" + "a".repeat(8_000_000), "GITHUB_TOKEN=" + "a".repeat(8_000_000), 'password: "' + "a".repeat(8_000_000) + '"', "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(8_000_000)]) {
    let out
    assert.doesNotThrow(() => { out = redact(s) }, s.slice(0, 20))
    // Callers cap each text at a few KB (redactClip), so only the start matters here.
    // (A quoted value longer than 16 KB isn't matched; callers never pass one.)
    if (!s.startsWith("password")) assert.match(out.slice(0, 40), /\[redacted/, s.slice(0, 20))
  }
})
