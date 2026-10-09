// Self-test of nova-env's progress_line operation (node >= 24 strips TypeScript types itself):
//   node test/progress-line.test.mjs
// The conflict it closes: the methodology wants the real HH:MM in progress.log lines, but a command that only asks the clock
// (date +%H:%M, Get-Date -Format HH:mm) is refused by the plugin. progress_line is the narrow allowed way: it appends ONE
// line '<code> k/N [HH:MM] <text>' with the machine time to a file named progress.log inside the project folder.
// Exit 1 on any failed cell.
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin, * as mod from "../index.ts"

let fail = 0
function cell(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " :: " + detail}`)
  if (!ok) fail++
}

const { isTimeOnlyCall, progressLine } = mod
const root = mkdtempSync(path.join(os.tmpdir(), "nova-env-pl-"))
const dir = path.join(root, "proj", "doc", "tasks", "007-x")
mkdirSync(dir, { recursive: true })
const base = path.join(root, "proj")
const log = path.join(dir, "progress.log")
const HISTORY = "С5д 3/13 [02:04] историческая строка\n"
writeFileSync(log, HISTORY)
const rel = "doc/tasks/007-x/progress.log"
const at = (h, m) => new Date(2026, 9, 9, h, m, 0)

// 0. The conflict itself (recorded, stays): the clock-only command is refused.
for (const c of ['date "+%H:%M"', "date +%H:%M", "Get-Date -Format HH:mm", '(Get-Date).ToString("HH:mm")'])
  cell(`conflict recorded, still refused: ${c}`, isTimeOnlyCall(c), "not refused")

// 1. The new path exists and writes the real time.
cell("progressLine exported", typeof progressLine === "function", "missing: there is no allowed way to put the time into progress.log")
if (typeof progressLine === "function") {
  const r = progressLine({ file: rel, code: "С5д", unit: "4/13", text: "ворота merge: замок только на проверенную вершину" }, base, at(3, 7))
  cell("appends one line with the given time", r.ok && r.line === "С5д 4/13 [03:07] ворота merge: замок только на проверенную вершину", JSON.stringify(r))
  const txt = readFileSync(log, "utf8")
  cell("history is kept, one new line only", txt.startsWith(HISTORY) && txt.split("\n").length === 3 && txt.endsWith("\n"), JSON.stringify(txt))

  // real clock when no time is passed
  const before = new Date()
  const r2 = progressLine({ file: log, code: "С5д", unit: "?/?", text: "реальное время" }, base)
  const after = new Date()
  const stamp = /\[(\d\d):(\d\d)\]/.exec(r2.line ?? "")
  const mins = (d) => d.getHours() * 60 + d.getMinutes()
  const got = stamp ? Number(stamp[1]) * 60 + Number(stamp[2]) : -1
  cell("real machine time (absolute path inside the project)", r2.ok && got >= mins(before) - 0 && got <= mins(after) + 0, JSON.stringify([r2, got, mins(before), mins(after)]))

  // 2. Narrowness: nothing else is accepted.
  const bad = (name, input, why) => {
    const snapshot = readFileSync(log, "utf8")
    const x = progressLine(input, base, at(3, 8))
    cell(`refused: ${name}`, x.ok === false && readFileSync(log, "utf8") === snapshot, JSON.stringify(x) + " " + why)
  }
  bad("other file name", { file: "doc/tasks/007-x/result.md", code: "С5д", unit: "5/13", text: "x" }, "")
  bad("file outside the project folder", { file: "../outside/progress.log", code: "С5д", unit: "5/13", text: "x" }, "")
  bad("absolute path outside", { file: path.join(root, "other", "progress.log"), code: "С5д", unit: "5/13", text: "x" }, "")
  bad("multi-line text", { file: rel, code: "С5д", unit: "5/13", text: "раз\nдва" }, "")
  bad("control characters", { file: rel, code: "С5д", unit: "5/13", text: "раз\u0007два" }, "")
  bad("long text", { file: rel, code: "С5д", unit: "5/13", text: "я".repeat(121) }, "")
  bad("empty text", { file: rel, code: "С5д", unit: "5/13", text: "  " }, "")
  bad("code with spaces", { file: rel, code: "С5 д", unit: "5/13", text: "x" }, "")
  bad("unit not k/N", { file: rel, code: "С5д", unit: "пять", text: "x" }, "")
  bad("missing file is not created", { file: "doc/tasks/008-y/progress.log", code: "С5д", unit: "1/2", text: "x" }, "")
  cell("missing file not created on disk", (() => { try { readFileSync(path.join(base, "doc/tasks/008-y/progress.log")); return false } catch { return true } })(), "created")

  // 3. File access denial is respected (read-only file: the operating system refuses, nothing changes).
  const ro = path.join(dir, "ro", "progress.log")
  mkdirSync(path.dirname(ro), { recursive: true })
  writeFileSync(ro, "С1 0/0 [01:00] запуск\n")
  chmodSync(ro, 0o444)
  const snap = readFileSync(ro, "utf8")
  const denied = progressLine({ file: ro, code: "С1", unit: "1/2", text: "x" }, base, at(3, 9))
  cell("file access denial is respected", denied.ok === false && /отказал|EPERM|EACCES/.test(denied.reason) && readFileSync(ro, "utf8") === snap, JSON.stringify(denied))
  chmodSync(ro, 0o644)
}

// 4. The tool is registered by setup and the time-only refusal stays in the permission hook.
{
  const tools = []
  const hooks = {}
  const ctx = {
    location: { directory: base },
    shell: { hook: async () => {} },
    session: { hook: async (n, fn) => { hooks[n] = fn } },
    permission: { hook: async (n, fn) => { hooks["permission." + n] = fn } },
    tool: { transform: async (cb) => cb({ add: (t) => tools.push(t) }) },
  }
  await plugin.setup(ctx)
  const t = tools.find((x) => x.name === "progress_line")
  cell("setup registers progress_line", !!t, JSON.stringify(tools.map((x) => x.name)))
  if (t) {
    const out = await t.execute({ file: rel, code: "С5д", unit: "6/13", text: "через инструмент" }, {})
    cell("tool execute writes and answers", /Записано: С5д 6\/13 \[\d\d:\d\d\] через инструмент/.test(out.content) && readFileSync(log, "utf8").includes("] через инструмент"), JSON.stringify(out))
    const no = await t.execute({ file: "doc/tasks/007-x/result.md", code: "С5д", unit: "6/13", text: "x" }, {})
    cell("tool execute refuses a wrong file", /^Не записано/.test(no.content), JSON.stringify(no))
  }
  const ev = { effect: "allow", action: "shell", metadata: { command: 'date "+%H:%M"' }, resources: [] }
  hooks["permission.evaluate"]?.(ev)
  cell("permission hook still denies the clock-only command", ev.effect === "deny", JSON.stringify(ev))
  const ok = { effect: "allow", action: "shell", metadata: { command: "git status" }, resources: [] }
  hooks["permission.evaluate"]?.(ok)
  cell("permission hook leaves other commands alone", ok.effect === "allow", JSON.stringify(ok))
}

console.log(fail ? `progress-line.test: FAIL ${fail}` : "progress-line.test ok")
process.exit(fail ? 1 : 0)
