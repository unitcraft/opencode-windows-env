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
//   * правило «время берётся из часов, а не из головы» (nova AGENTS.md, «Время»)
//     в Claude Code держал хук; здесь — строка в каждом запросе модели.
//
// ЧТО ДЕЛАЕТ: перед каждой командой оболочки — Git Bash первым в PATH (Windows),
// `PYTHONUTF8=1`, `TEMP`/`TMP`/`TMPDIR` на каталог `Temp` того диска, где
// выполняется команда (если такой каталог есть), а в Windows PowerShell —
// чтение и вывод в UTF-8. ЗАПИСЬ не трогается: `*:Encoding` у Set-Content/Out-File
// в 5.1 ставил бы BOM в файлы. В каждый запрос модели — `ВРЕМЯ СЕЙЧАС HH:MM`.

import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const LOG = path.join(os.tmpdir(), "nova-opencode-plugins.log")
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

    await ctx.session.hook("context", (ev: any) => {
      try {
        const d = new Date()
        const hh = String(d.getHours()).padStart(2, "0")
        const mm = String(d.getMinutes()).padStart(2, "0")
        ev.system.push({ type: "text", text: `ВРЕМЯ СЕЙЧАС ${hh}:${mm} (местное, часы машины; nova-env)` })
      } catch (e) {
        log(`time inject failed: ${e}`)
      }
    })
  },
}
