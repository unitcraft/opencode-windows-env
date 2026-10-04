// Self-test of nova-env's message time stamp (node >= 24 strips TypeScript types itself):
//   node test/stamp.test.mjs
// Feeds three SSE protocols through stampStream and checks: exactly one HH:MM per text
// block, at its start; reasoning/tool deltas and non-JSON lines untouched; a stream split
// in the middle of a line still stamps once. Exit 1 on any failed cell.
import { stampStream, isTimeOnlyCall } from "../index.ts"

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
