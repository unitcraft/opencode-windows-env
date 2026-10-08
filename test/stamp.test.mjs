// Self-test of nova-env's message time stamp (node >= 24 strips TypeScript types itself):
//   node test/stamp.test.mjs
// Feeds three SSE protocols through stampStream and checks: exactly one HH:MM per text
// block, at its start; reasoning/tool deltas and non-JSON lines untouched; a stream split
// in the middle of a line still stamps once. Exit 1 on any failed cell.
import { stampStream, isTimeOnlyCall, stripStamps } from "../index.ts"

const enc = new TextEncoder()
const STAMP = /^\d\d:\d\d\n\n/

function streamOf(chunks) {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    },
  })
}

async function run(chunks) {
  const out = await new Response(stampStream(streamOf(chunks))).text()
  return out
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l && l !== "[DONE]")
    .map((l) => JSON.parse(l))
}

const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
let fail = 0
function cell(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " :: " + detail}`)
  if (!ok) fail++
}

// Anthropic: two text blocks, a thinking delta, a tool input delta.
{
  const r = await run([
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } }),
    ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } }),
    ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " world" } }),
    ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{" } }),
    ev({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Second" } }),
  ])
  cell("anthropic: thinking untouched", r[0].delta.thinking === "hm", JSON.stringify(r[0]))
  cell("anthropic: first text stamped", STAMP.test(r[1].delta.text) && r[1].delta.text.endsWith("Hello"), r[1].delta.text)
  cell("anthropic: continuation not stamped", r[2].delta.text === " world", r[2].delta.text)
  cell("anthropic: tool json untouched", r[3].delta.partial_json === "{", JSON.stringify(r[3]))
  cell("anthropic: second block stamped", STAMP.test(r[4].delta.text), r[4].delta.text)
}

// OpenAI Chat, split in the middle of an event line.
{
  const a = ev({ choices: [{ index: 0, delta: { content: "Hi" } }] })
  const b = ev({ choices: [{ index: 0, delta: { content: " there" } }] })
  const r = await run([a.slice(0, 15), a.slice(15) + b, "data: [DONE]\n\n"])
  cell("chat: first content stamped across a split", STAMP.test(r[0].choices[0].delta.content), r[0].choices[0].delta.content)
  cell("chat: continuation not stamped", r[1].choices[0].delta.content === " there", r[1].choices[0].delta.content)
}

// OpenAI Responses.
{
  const r = await run([
    ev({ type: "response.output_text.delta", item_id: "m1", content_index: 0, delta: "Ok" }),
    ev({ type: "response.output_text.delta", item_id: "m1", content_index: 0, delta: "!" }),
    ev({ type: "response.reasoning_summary_text.delta", item_id: "r1", delta: "think" }),
  ])
  cell("responses: first delta stamped", STAMP.test(r[0].delta), r[0].delta)
  cell("responses: continuation not stamped", r[1].delta === "!", r[1].delta)
  cell("responses: reasoning untouched", r[2].delta === "think", r[2].delta)
}

// Whitespace-only first chunks (Kimi sends an empty block before a tool call) get no stamp; the first chunk with text does.
{
  const chunk = (c) => ev({ choices: [{ index: 0, delta: { content: c } }] })
  const r = await run([chunk("\n"), chunk("  "), chunk("Готово"), chunk(" дальше")])
  cell("chat: whitespace chunks not stamped", r[0].choices[0].delta.content === "\n" && r[1].choices[0].delta.content === "  ", JSON.stringify([r[0], r[1]]))
  cell("chat: first text chunk stamped once", STAMP.test(r[2].choices[0].delta.content) && r[3].choices[0].delta.content === " дальше", JSON.stringify([r[2], r[3]]))
  const only = await run([chunk("\n")])
  cell("chat: block of whitespace only gets no stamp", only[0].choices[0].delta.content === "\n", JSON.stringify(only))
}

// History: leading stamps of assistant messages are cut before the request goes to the model; nothing else changes.
{
  const body = JSON.stringify({ model: "k3", messages: [
    { role: "system", content: "02:31\n\nsystem keeps" },
    { role: "user", content: "02:31\n\nuser keeps" },
    { role: "assistant", content: "02:38\n\n02:31\n\n02:31\n\nОтвет" },
    { role: "assistant", content: [{ type: "text", text: "02:30\n\nчасти" }, { type: "tool_use", name: "x" }] },
    { role: "assistant", content: "02:31\n\n" },
    { role: "assistant", content: "Без штампа 12:30 внутри" },
  ] })
  const o = JSON.parse(stripStamps(body)).messages
  cell("strip: assistant string cleaned", o[2].content === "Ответ", JSON.stringify(o[2]))
  cell("strip: assistant parts cleaned", o[3].content[0].text === "части" && o[3].content[1].name === "x", JSON.stringify(o[3]))
  cell("strip: system and user untouched", o[0].content.startsWith("02:31") && o[1].content.startsWith("02:31"), JSON.stringify([o[0], o[1]]))
  cell("strip: stamp-only message kept", o[4].content === "02:31\n\n", JSON.stringify(o[4]))
  cell("strip: stamp inside text kept", o[5].content === "Без штампа 12:30 внутри", JSON.stringify(o[5]))
  cell("strip: nothing to change returns same body", stripStamps('{"messages":[]}') === '{"messages":[]}' && stripStamps("not json") === "not json", "changed")
  const resp = JSON.parse(stripStamps(JSON.stringify({ input: [{ role: "assistant", content: [{ type: "output_text", text: "02:31\n\nответ" }] }] })))
  cell("strip: responses input cleaned", resp.input[0].content[0].text === "ответ", JSON.stringify(resp))
}

// Garbage passes through unchanged.
{
  const raw = "event: ping\ndata: not json\n\n"
  const out = await new Response(stampStream(streamOf([raw]))).text()
  cell("non-JSON passes unchanged", out === raw, JSON.stringify(out))
}

// Time-only shell calls are refused; other uses of date/Get-Date are not.
for (const c of ['Get-Date -Format "HH:mm"', "Get-Date -Format HH:mm", 'date "+%H:%M"', "date +%H:%M",
                 "git status; Get-Date -Format 'HH:mm'", '(Get-Date).ToString("HH:mm")']) {
  cell(`time-only refused: ${c}`, isTimeOnlyCall(c), "not refused")
}
for (const c of ["Get-Date", 'Get-Date -Format "yyyy-MM-dd HH:mm:ss"', "date -u +%s", "git log --date=short",
                 'echo "date +%H:%M"']) {
  cell(`other use passes: ${c}`, !isTimeOnlyCall(c), "refused")
}

console.log(fail ? `stamp.test: FAIL ${fail}` : "stamp.test ok")
process.exit(fail ? 1 : 0)
