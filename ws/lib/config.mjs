// $WS_ROOT/config.json, validated. Bad values are dropped (with a message) rather than
// passed on, and nothing here ever throws: hooks read config too and must not fail.
import { promises as fs } from "node:fs"
import path from "node:path"
import { ROOT } from "./store.mjs"

export const CONFIG_FILE = path.join(ROOT, "config.json")

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function validateConfig(raw) {
  const problems = []
  const out = { llm: {}, board: {} }
  if (raw === undefined) return { ...out, problems }
  if (!isObj(raw)) return { ...out, problems: ["config.json must be a JSON object; ignoring it"] }

  if (raw.llm !== undefined) {
    if (!isObj(raw.llm)) problems.push("llm must be an object")
    else {
      const l = raw.llm
      if (l.url !== undefined) {
        if (typeof l.url === "string" && /^https?:\/\/[^\s]+$/.test(l.url)) out.llm.url = l.url
        else problems.push("llm.url must be an http(s) URL")
      }
      if (l.model !== undefined) {
        if (typeof l.model === "string" && l.model.trim()) out.llm.model = l.model.trim()
        else problems.push("llm.model must be a non-empty string")
      }
      if (l.apiKeyEnv !== undefined) {
        if (typeof l.apiKeyEnv === "string" && ENV_NAME.test(l.apiKeyEnv)) out.llm.apiKeyEnv = l.apiKeyEnv
        else problems.push("llm.apiKeyEnv must be an environment variable name (the key itself never goes in config.json)")
      }
      if (l.timeoutMs !== undefined) {
        if (Number.isInteger(l.timeoutMs) && l.timeoutMs >= 1000 && l.timeoutMs <= 30 * 60_000) out.llm.timeoutMs = l.timeoutMs
        else problems.push("llm.timeoutMs must be an integer between 1000 and 1800000")
      }
      if (l.extraBody !== undefined) {
        if (!isObj(l.extraBody)) problems.push("llm.extraBody must be an object")
        else {
          const { model, messages, ...rest } = l.extraBody
          if (model !== undefined || messages !== undefined) problems.push("llm.extraBody can't set model or messages; ignoring those keys")
          out.llm.extraBody = rest
        }
      }
    }
  }

  if (raw.board !== undefined) {
    if (!isObj(raw.board)) problems.push("board must be an object")
    else {
      const b = raw.board
      if (b.port !== undefined) {
        const n = Number(b.port)
        if (Number.isInteger(n) && n >= 1 && n <= 65535) out.board.port = n
        else problems.push("board.port must be an integer between 1 and 65535")
      }
      if (b.label !== undefined) {
        if (typeof b.label === "string" && LABEL.test(b.label)) out.board.label = b.label
        else problems.push("board.label may only contain letters, digits, '.', '_' and '-'")
      }
    }
  }
  return { ...out, problems }
}

export async function loadConfig(file = CONFIG_FILE) {
  let text
  try { text = await fs.readFile(/* turbopackIgnore: true */ file, "utf-8") } catch (e) {
    if (e.code === "ENOENT") return validateConfig(undefined)
    return { ...validateConfig(undefined), problems: [`can't read ${file}: ${e.code || e.message}`] }
  }
  let raw
  try { raw = JSON.parse(text) } catch {
    return { ...validateConfig(undefined), problems: ["config.json is not valid JSON; using defaults"] }
  }
  return validateConfig(raw)
}
