// plugins/nova-env — окружение КАЖДОЙ команды оболочки и часы машины в каждом запросе.
//
// ЗАЧЕМ (замеры 2026-10-03, переезд работы Nova в OpenCode V2):
//   * оболочки фоновых субагентов получали окружение СЕРВИСА OpenCode, а не
//     лаунчера: `bash` там — WSL (`C:\Windows\system32\bash.exe`), и стражи,
//     написанные под Git Bash, отвечали «не git-репозиторий», ничего не проверив;
//   * Windows PowerShell 5.1 пишет вывод в кодовой странице консоли (cp866), а
//     OpenCode читает его как UTF-8 — кириллица приходила кракозябрами;
//   * `TEMP` на диске D: ломает сам OpenCode (ошибка 126 при загрузке DLL
//     рендерера), поэтому лаунчер его не задаёт — а прогонам Nova он нужен там:
//     системный диск уже уходил под ноль (реестр nova 221.1 №1152);
//   * правило «время берётся из часов, а не из головы» (правило проекта о времени в докладах)
//     в Claude Code держал хук; здесь — штамп в ответе (строка часов в каждом
//     запросе была до 2026-10-04 и снята: ломала кэш промпта);
//   * а «каждое сообщение человеку начинается со времени» держалось ВНИМАНИЕМ
//     агента: он звал `Get-Date` перед каждым докладом и всё равно ставил его
//     через раз. Слово владельца 2026-10-03: время у ЛЮБОГО текстового сообщения
//     агента ставит плагин, а не агент.
//
// ЧТО ДЕЛАЕТ: перед каждой командой оболочки — Git Bash первым в PATH (Windows),
// `PYTHONUTF8=1`, `TEMP`/`TMP`/`TMPDIR` на каталог `Temp` того диска, где
// выполняется команда (если такой каталог есть), а в Windows PowerShell —
// чтение и вывод в UTF-8. ЗАПИСЬ не трогается: `*:Encoding` у Set-Content/Out-File
// в 5.1 ставил бы BOM в файлы. В подсказку модели — только НЕИЗМЕННЫЙ текст
// (часы в подсказке ломали кэш промпта, см. хук `context` ниже).
//
// ШТАМП ВРЕМЕНИ. Ответ модели идёт потоком SSE; плагин переписывает поток
// (`session.hook("http.response")`, только агентный цикл, kind = "primary") и
// ставит `HH:MM` перед ПЕРВЫМ куском каждого текстового блока — время, когда
// блок начал печататься. Понимает три протокола: Anthropic Messages
// (`content_block_delta`/`text_delta`), OpenAI Chat (`choices[].delta.content`),
// OpenAI Responses (`response.output_text.delta`). Чего не понял — пропускает
// без изменений: сбой разбора не должен ломать ответ. Штамп попадает и в
// историю сессии — по ней сверяют порядок событий. Транспорт WebSocket
// (`experimental.ws.*`) не переписывается — названная граница.

import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const LOG = path.join(os.tmpdir(), "opencode-plugins.log")
const log = (line: string) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} nova-env ${line}\n`)
  } catch {}
}

const PS_UTF8 =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;" +
  "$PSDefaultParameterValues['Get-Content:Encoding']='UTF8';$PSDefaultParameterValues['Select-String:Encoding']='UTF8';\n"

function gitBashDir(): string | undefined {
  if (process.platform !== "win32") return undefined
  try {
    const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).trim()
    // <git>/mingw64/libexec/git-core -> <git>/bin
    const bin = path.resolve(exec, "..", "..", "..", "bin")
    return existsSync(path.join(bin, "bash.exe")) ? bin : undefined
  } catch (e) {
    log(`git --exec-path failed: ${e}`)
    return undefined
  }
}

function tempFor(dir: string): { win: string; posix: string } | undefined {
  if (process.platform !== "win32") return undefined
  const drive = /^([A-Za-z]):/.exec(dir)?.[1]
  if (!drive) return undefined
  const win = `${drive.toUpperCase()}:\\Temp`
  return existsSync(win) ? { win, posix: `/${drive.toLowerCase()}/Temp` } : undefined
}

const envKey = (env: Record<string, string | undefined>, name: string) =>
  Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name

function hhmm(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

// Штамп в первый кусок каждого текстового блока одного ответа. Кусок из одних пробелов и переводов строки штампа не получает
// (2026-10-09: Kimi перед вызовом инструмента шлёт пустой блок, и в сессии копились одинокие «01:56 01:56 …»): штамп встанет на первый кусок с текстом. Возвращает
// изменённую JSON-строку или undefined, если менять нечего.
function stampEvent(obj: any, seen: Set<string>): boolean {
  const stamp = `${hhmm()}\n\n`
  // Anthropic Messages
  if (obj?.type === "content_block_delta" && obj.delta?.type === "text_delta" && typeof obj.delta.text === "string") {
    const key = `a${obj.index ?? 0}`
    if (seen.has(key) || obj.delta.text.trim() === "") return false
    seen.add(key)
    obj.delta.text = stamp + obj.delta.text
    return true
  }
  // OpenAI Responses
  if (obj?.type === "response.output_text.delta" && typeof obj.delta === "string") {
    const key = `r${obj.item_id ?? ""}:${obj.content_index ?? 0}`
    if (seen.has(key) || obj.delta.trim() === "") return false
    seen.add(key)
    obj.delta = stamp + obj.delta
    return true
  }
  // OpenAI Chat Completions
  if (Array.isArray(obj?.choices)) {
    let changed = false
    for (const ch of obj.choices) {
      const c = ch?.delta?.content
      if (typeof c !== "string" || c.trim() === "") continue
      const key = `c${ch.index ?? 0}`
      if (seen.has(key)) continue
      seen.add(key)
      ch.delta.content = stamp + c
      changed = true
    }
    return changed
  }
  return false
}

// Команда, которая ТОЛЬКО спрашивает часы ради доклада: `date "+%H:%M"`,
// `Get-Date -Format HH:mm` и их варианты кавычек. Время ставит штамп, а
// текст-правило «не зови date» окна не удержал (замер 2026-10-03: оба окна звали
// его после указания в каждом запросе) — поэтому отказ, а не просьба. Прочие
// формы `date`/`Get-Date` (полная дата, вычисления) не трогаются.
const TIME_ONLY = [
  /^date\s+["']?\+%H:%M["']?$/i,
  /^get-date\s+-format\s+["']?HH:mm["']?$/i,
  /^\(get-date\)\.tostring\(["']HH:mm["']\)$/i,
]
export function isTimeOnlyCall(command: string): boolean {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => TIME_ONLY.some((re) => re.test(s)))
}


// ШТАМПЫ В ИСТОРИИ. Плагин ставит HH:MM в начало ответа, и штамп остаётся в истории сессии. Модели слабее (Kimi K3 на низком усилии)
// копируют его сами: в начале ответа копится стопка «02:31 02:31 …» со старыми временами (2026-10-09, замер владельца). Перед
// отправкой запроса модели штампы в начале текстов ответов ассистента вырезаются: модель их не видит и не подражает, а свой
// штамп плагин ставит по-прежнему на выходе. Вырезание детерминировано, поэтому кэш префикса запроса не ломается.
const LEAD_STAMPS = /^(?:\s*\d{2}:\d{2})+\s*/
const stripLead = (t: any): any => {
  if (typeof t !== "string") return t
  const out = t.replace(LEAD_STAMPS, "")
  return out === "" ? t : out // сообщение из одних штампов не опустошаем: пустой ответ API не принимают
}
// Тело запроса (JSON) -> тело без штампов у ответов ассистента; не JSON или нечего менять — исходная строка.
export function stripStamps(body: string): string {
  let obj: any
  try {
    obj = JSON.parse(body)
  } catch {
    return body
  }
  let changed = false
  const fixContent = (m: any) => {
    if (typeof m?.content === "string") {
      const n = stripLead(m.content)
      if (n !== m.content) {
        m.content = n
        changed = true
      }
    } else if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (part && (part.type === "text" || part.type === "output_text") && typeof part.text === "string") {
          const n = stripLead(part.text)
          if (n !== part.text) {
            part.text = n
            changed = true
          }
        }
      }
    }
  }
  for (const key of ["messages", "input"]) {
    if (!Array.isArray(obj?.[key])) continue
    for (const m of obj[key]) if (m?.role === "assistant") fixContent(m)
  }
  return changed ? JSON.stringify(obj) : body
}


// ЗАПИСЬ ПРОГРЕССА (2026-10-09). Методика требует фактическое время в строках журнала прогресса (`<код> k/N [ЧЧ:ММ] <что делается>`), а
// запрос времени командой запрещён выше (его ставит штамп, а не команда). Чтобы запрет не мешал журналу, у агента есть узкая
// операция: она сама берёт время машины и дописывает ОДНУ строку в файл с именем progress.log внутри папки проекта окна.
// Никакой оболочки и произвольных путей: имя файла, код сессии, счёт k/N и текст проверяются, права файла соблюдаются
// (отказ файловой системы возвращается отказом, файл не меняется). Историческое время журналов не переписывается: операция только дописывает.
export type ProgressInput = { file: string; code: string; unit: string; text: string }
const CODE_RE = /^[A-Za-zА-Яа-яЁё0-9]{1,8}$/
const UNIT_RE = /^(?:\d{1,4}\/\d{1,4}|\?\/\?)$/
export function progressLine(
  input: ProgressInput,
  base: string,
  now: Date = new Date(),
): { ok: true; line: string; file: string } | { ok: false; reason: string } {
  const text = String(input?.text ?? "").trim()
  const code = String(input?.code ?? "").trim()
  const unit = String(input?.unit ?? "").trim()
  const file = String(input?.file ?? "").trim()
  if (!CODE_RE.test(code)) return { ok: false, reason: "код сессии: 1–8 букв или цифр без пробелов (например С5д)" }
  if (!UNIT_RE.test(unit)) return { ok: false, reason: "счёт: k/N числами (например 4/13) или ?/?" }
  if (!text) return { ok: false, reason: "текст пустой" }
  if (/[\r\n\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: "текст в одну строку, без управляющих символов" }
  if ([...text].length > 120) return { ok: false, reason: "текст длиннее 120 знаков (строка журнала до 80 знаков по правилу проекта; сократи)" }
  if (!file) return { ok: false, reason: "не назван файл progress.log" }
  const abs = path.resolve(base, file)
  if (path.basename(abs).toLowerCase() !== "progress.log") return { ok: false, reason: "писать можно только в файл с именем progress.log" }
  const rel = path.relative(path.resolve(base), abs)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, reason: "файл вне папки проекта окна" }
  let st
  try {
    st = statSync(abs)
  } catch {
    return { ok: false, reason: "файла нет: журнал создаёт сессия методики, эта операция только дописывает" }
  }
  if (!st.isFile()) return { ok: false, reason: "это не файл" }
  const line = `${code} ${unit} [${hhmm(now)}] ${text}`
  try {
    appendFileSync(abs, line + "\n", "utf8")
  } catch (e: any) {
    return { ok: false, reason: `файловая система отказала: ${e?.code ?? e}` }
  }
  return { ok: true, line, file: abs }
}

// Экспорт — для самотеста `test/stamp.test.mjs`; OpenCode читает только default.
export function stampStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  const seen = new Set<string>()
  let buf = ""
  const fix = (line: string): string => {
    if (!line.startsWith("data:")) return line
    const raw = line.slice(5).trimStart()
    if (!raw || raw === "[DONE]") return line
    try {
      const obj = JSON.parse(raw)
      return stampEvent(obj, seen) ? `data: ${JSON.stringify(obj)}` : line
    } catch {
      return line
    }
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        buf += dec.decode(chunk, { stream: true })
        const nl = buf.lastIndexOf("\n")
        if (nl < 0) return
        const done = buf.slice(0, nl + 1)
        buf = buf.slice(nl + 1)
        ctl.enqueue(enc.encode(done.split("\n").map((l) => fix(l.replace(/\r$/, "")) + (l.endsWith("\r") ? "\r" : "")).join("\n")))
      },
      flush(ctl) {
        buf += dec.decode()
        if (buf) ctl.enqueue(enc.encode(fix(buf)))
      },
    }),
  )
}

export default {
  id: "nova.env",
  async setup(ctx: any) {
    const bashDir = gitBashDir()
    log(`setup location=${ctx?.location?.directory ?? "?"} gitbash=${bashDir ?? "-"}`)

    await ctx.shell.hook("create.before", (ev: any) => {
      try {
        const env = ev.env
        env.PYTHONUTF8 = "1"
        if (bashDir) {
          const k = envKey(env, "PATH")
          const cur = env[k] ?? ""
          if (!cur.toLowerCase().startsWith(bashDir.toLowerCase() + ";")) env[k] = `${bashDir};${cur}`
        }
        const temp = tempFor(String(ev.cwd ?? ctx?.location?.directory ?? ""))
        if (temp) {
          env[envKey(env, "TEMP")] = temp.win
          env[envKey(env, "TMP")] = temp.win
          env.TMPDIR = temp.posix
        }
        if (/powershell/i.test(String(ev.shell ?? "")) && !String(ev.command).startsWith(PS_UTF8)) {
          ev.command = PS_UTF8 + ev.command
        }
      } catch (e) {
        log(`shell env failed: ${e}`)
      }
    })

    // ПОДСКАЗКА — НЕИЗМЕННАЯ. Прежде здесь ехала строка «ВРЕМЯ СЕЙЧАС HH:MM»: она
    // меняется раз в минуту и стоит в системной части, то есть ПЕРЕД всей историей,
    // а кэш промпта Claude совпадает только по префиксу. Замер владельца 2026-10-04
    // (Sonnet 5.5, 40 шагов): кэш падал до 4 819 токенов (одни инструменты), и
    // 75–97 тыс. токенов истории платились заново — 6 раз за ход. Время в ответ
    // по-прежнему ставит штамп (поток ответа, кэш не трогает); часы модели не нужны.
    await ctx.session.hook("context", (ev: any) => {
      try {
        ev.system.push({
          type: "text",
          text: "Время в начало каждого твоего текстового сообщения ставит плагин nova-env сам — НЕ пиши его и не зови для этого date/Get-Date.",
        })
      } catch (e) {
        log(`hint inject failed: ${e}`)
      }
    })


    // Операция записи прогресса (см. progressLine): единственный разрешённый способ поставить настоящее время в журнал прогресса.
    try {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "progress_line",
          description:
            "Append ONE line to a progress.log of the current project: '<code> <k/N> [HH:MM] <text>'. The plugin puts the machine time itself; do not ask the clock with date or Get-Date (refused). Only a file named progress.log inside the project folder, only appending; the file must exist. Example: file 'doc/tasks/007-x/progress.log', code 'С5д', unit '4/13', text 'ворота merge: замок только на проверенную вершину'.",
          input: {
            type: "object",
            properties: {
              file: { type: "string", description: "path to progress.log, relative to the project folder or absolute inside it" },
              code: { type: "string", description: "session code, e.g. С5д" },
              unit: { type: "string", description: "k/N as numbers, e.g. 4/13, or ?/?" },
              text: { type: "string", description: "what is being done, one line, up to 120 characters" },
            },
            required: ["file", "code", "unit", "text"],
          },
          execute: async (input: any) => {
            const r = progressLine(input, String(ctx?.location?.directory ?? process.cwd()))
            if (!r.ok) {
              log(`progress_line refused: ${r.reason}`)
              return { content: `Не записано: ${r.reason}` }
            }
            return { content: `Записано: ${r.line}` }
          },
        })
      })
    } catch (e) {
      log(`progress_line tool not registered: ${e}`)
    }

    await ctx.permission.hook("evaluate", (ev: any) => {
      try {
        if (ev.effect === "deny" || ev.action !== "shell") return
        const meta = ev?.metadata ?? {}
        const command = typeof meta.command === "string" && meta.command ? meta.command : (ev.resources ?? []).join("\n")
        if (!isTimeOnlyCall(String(command))) return
        ev.effect = "deny"
        ev.message =
          "nova-env: время не спрашивают командой — его ставит плагин в начало каждого твоего текстового сообщения " +
          "Не пиши время сам."
        log(`deny time-only call: ${command}`)
      } catch (e) {
        log(`time deny failed: ${e}`)
      }
    })


    // Запрос модели: вырезать штампы времени из истории (см. stripStamps). Форма события не документирована: берём ev.request
    // (Request), чужое и непонятное пропускаем без изменений; сбой не ломает запрос.
    try {
      await ctx.session.hook("http.request", async (ev: any) => {
        try {
          const req = ev?.request
          if (!(req instanceof Request) || req.method !== "POST") return
          if (!/json/i.test(req.headers.get("content-type") ?? "")) return
          const text = await req.clone().text()
          const out = stripStamps(text)
          if (out === text) return
          const headers = new Headers(req.headers)
          headers.delete("content-length")
          ev.request = new Request(req.url, { method: req.method, headers, body: out, signal: req.signal })
          log(`strip stamps: ${text.length - out.length} chars removed from the request history`)
        } catch (e) {
          log(`strip stamps failed: ${e}`)
        }
      })
    } catch (e) {
      log(`http.request hook not available: ${e}`)
    }

    await ctx.session.hook("http.response", (ev: any) => {
      try {
        if (ev.kind !== "primary") return
        const res: Response = ev.response
        const type = res.headers.get("content-type") ?? ""
        if (!res.body || !/event-stream/i.test(type)) return
        const headers = new Headers(res.headers)
        headers.delete("content-length")
        ev.response = new Response(stampStream(res.body), { status: res.status, statusText: res.statusText, headers })
      } catch (e) {
        log(`stamp failed: ${e}`)
      }
    })
  },
}
