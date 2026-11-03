// Checks the plugin's shape the way magpie does, and — with DOUBAO_E2E=1 and
// 豆包工作 installed and signed in on this Mac — signs in through it and sends
// one real turn, streaming and non-streaming.
import assert from "node:assert"
import { existsSync } from "node:fs"
import { DoubaoDesktopPlugin, _internal } from "./index.mjs"

const hooksOf = async () => DoubaoDesktopPlugin({ client: {} })

const offline = [
  ["plugin is a function", async () => assert.equal(typeof DoubaoDesktopPlugin, "function")],

  ["hooks are there", async () => {
    const hooks = await hooksOf()
    assert.equal(typeof hooks.config, "function")
    assert.equal(typeof hooks.provider.models, "function")
    assert.equal(hooks.auth.provider, _internal.PROVIDER)
    assert.equal(hooks.auth.single, true)
    assert.equal(typeof hooks.auth.loader, "function")
  }],

  ["config declares npm and models", async () => {
    const cfg = { provider: {} }
    await (await hooksOf()).config(cfg)
    const p = cfg.provider[_internal.PROVIDER]
    assert.equal(p.npm, "@ai-sdk/openai-compatible")
    assert.ok(Object.keys(p.models).length >= 3)
    assert.equal(p.models["doubao-2.1-pro"].tool_call, true, "tools ride the emulated protocol")
    assert.equal(
      Object.values(p.models).every((m) => m.reasoning === false),
      true,
      "no separate reasoning stream exists, so none may be claimed",
    )
  }],

  ["one sign-in method, reading the desktop app", async () => {
    const [m] = (await hooksOf()).auth.methods
    assert.equal(m.type, "oauth")
    assert.match(m.label, /豆包工作/)
    const flow = await m.authorize()
    assert.equal(flow.method, "auto")
    assert.equal(flow.url, "", "no browser page is opened")
    assert.equal(typeof flow.callback, "function")
  }],

  ["loader is empty until signed in", async () => {
    const hooks = await hooksOf()
    assert.deepEqual(await hooks.auth.loader(async () => ({})), {})
  }],

  ["a turn needs a user message", async () => {
    const hooks = await hooksOf()
    const loader = await hooks.auth.loader(async () => ({ source: "doubao-work-desktop" }))
    const res = await loader.fetch("https://www.doubao.com/magpie-doubao/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "doubao-2.1-pro", messages: [{ role: "system", content: "x" }] }),
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error.message, /user/)
  }],

  ["an endpoint it doesn't serve is refused", async () => {
    const hooks = await hooksOf()
    const loader = await hooks.auth.loader(async () => ({ source: "doubao-work-desktop" }))
    const res = await loader.fetch("https://www.doubao.com/magpie-doubao/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "doubao-2.1-pro", input: [] }),
    })
    assert.equal(res.status, 404)
  }],

  ["a body that isn't JSON is refused", async () => {
    const hooks = await hooksOf()
    const loader = await hooks.auth.loader(async () => ({ source: "doubao-work-desktop" }))
    const res = await loader.fetch("https://www.doubao.com/magpie-doubao/v1/chat/completions", {
      method: "POST",
      body: "not json",
    })
    assert.equal(res.status, 400)
  }],

  ["the text block carries the prompt where Doubao reads it", async () => {
    const b = _internal.textBlock("你好")
    assert.equal(b.block_type, 10000, "BLOCK_TEXT")
    assert.equal(b.content.text_block.text, "你好")
    assert.ok(b.block_id, "a block id is needed")
  }],

  ["the answer is assembled once, whichever order it arrives in", async () => {
    // What the endpoint really does with a short reply: the block carries the
    // first character, the patch carries the rest. Taking only one of them
    // reads "好" or "的".
    const a = _internal.newAccumulator()
    let out = ""
    out += a.acceptWhole("好") ?? ""
    out += a.acceptPatch("的") ?? ""
    assert.equal(out, "好的")

    // And with a long one: a block of "1", then the patches carry on.
    const b = _internal.newAccumulator()
    out = ""
    out += b.acceptWhole("1") ?? ""
    for (const d of ["、", "2", "、", "3"]) out += b.acceptPatch(d) ?? ""
    assert.equal(out, "1、2、3")

    // A final block that agrees with the patches adds nothing; one that got
    // ahead adds only what's new; one that fell behind is ignored.
    const c = _internal.newAccumulator()
    out = ""
    for (const d of ["今天", "天气"]) out += c.acceptPatch(d) ?? ""
    out += c.acceptWhole("今天天气") ?? ""
    out += c.acceptWhole("今天天气不错") ?? ""
    out += c.acceptWhole("今天") ?? ""
    assert.equal(out, "今天天气不错")

    // A block unlike what was sent doesn't overwrite it.
    const d = _internal.newAccumulator()
    assert.equal(d.acceptWhole("甲"), "甲")
    assert.equal(d.acceptWhole("乙"), null)
    assert.equal(d.text, "甲")
  }],

  ["the turns are sent along, since Doubao won't carry them", async () => {
    const single = [{ role: "user", content: "你好" }]
    assert.equal(_internal.buildPrompt(single), "你好", "one turn is sent as it stands")

    const withSystem = [
      { role: "system", content: "你是编码助手" },
      { role: "user", content: "暗号是紫罗兰" },
      { role: "assistant", content: "收到" },
      { role: "user", content: "暗号是什么" },
    ]
    const p = _internal.buildPrompt(withSystem)
    assert.ok(p.includes("暗号是紫罗兰"), "the earlier turn is carried")
    assert.ok(p.includes("收到"), "the assistant's own reply is carried")
    assert.ok(!p.includes("你是编码助手"), "the harness's system prompt is not paid for every turn")
    assert.ok(p.indexOf("暗号是什么") > p.indexOf("暗号是紫罗兰"), "newest last")

    // A long history keeps the newest turns.
    const long = []
    for (let i = 0; i < 200; i++) long.push({ role: i % 2 ? "user" : "assistant", content: `第${i}轮` + "x".repeat(60) })
    long.push({ role: "user", content: "最后一问" })
    const kept = _internal.buildPrompt(long)
    assert.ok(kept.length < JSON.stringify(long).length, "history is capped")
    assert.ok(kept.includes("最后一问"), "the newest turn survives")
    assert.ok(!kept.includes("第0轮"), "the oldest goes first")
  }],

  ["a harness's own context never becomes the question", async () => {
    // What actually broke in real use: the harness appends its clock and time
    // zone as a trailing user message, and "answer the last message" then made
    // Doubao reply about the timestamp while the user's ask, and the picture
    // it referred to, went unanswered.
    const ask = { role: "user", content: [{ type: "text", text: "帮我下载这里面的课程ppt" }, { type: "image" }] }
    const noise = {
      role: "user",
      content:
        "Time sampled while preparing turn 19, step 1: 2026-11-02T20:40:12+08:00[Asia/Shanghai]\n" +
        "Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\n" +
        "Elapsed since the preceding model-visible message: 1h 15m 58s.",
    }

    const one = _internal.buildPrompt([ask, noise])
    assert.match(one, /帮我下载/, "the ask is what gets asked")
    assert.ok(!one.includes("Time sampled"), "the harness's clock is not part of the question")

    // The same, with the assistant's reply in between, so the stripped noise
    // would otherwise leave the conversation ending on the assistant.
    const after = _internal.buildPrompt([ask, { role: "assistant", content: "我先看看" }, noise])
    assert.match(after, /帮我下载/)
    assert.ok(!after.includes("我先看看"), "an unfinished reply isn't history either")

    // An attachment that can't be sent is said so, instead of being guessed at.
    assert.match(one, /看不到/, "the model is told the picture didn't arrive")
    assert.ok(!_internal.buildPrompt([{ role: "user", content: "纯文字问题" }]).includes("看不到"), "no note when nothing was dropped")

    // Nothing but harness context: no question, and no request is made up.
    assert.equal(_internal.buildPrompt([noise]), "")
    assert.equal(_internal.buildPrompt([]), "")

    // System prompt stays out, and the current ask is last.
    const multi = _internal.buildPrompt([
      { role: "system", content: "一长段 harness 的系统提示词" },
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ])
    assert.ok(!multi.includes("系统提示词"))
    assert.ok(multi.indexOf("第二问") > multi.indexOf("第一问"))
  }],

  ["the tool protocol round-trips", async () => {
    const spec = _internal.toolSpec([{ type: "function", function: { name: "read", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } } }])
    assert.match(spec, /"name":"read"/)
    assert.match(spec, /TOOL_CALL/)
    assert.equal(_internal.toolSpec([]), "", "no tools, no spec")
    assert.equal(_internal.toolSpec(undefined), "")

    const { calls, rest, pending } = _internal.extractCalls(
      '好的。TOOL_CALL {"name":"read","arguments":{"path":"/a.txt"}} END_CALL 等一下再看。',
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, "read")
    assert.deepEqual(calls[0].arguments, { path: "/a.txt" })
    assert.ok(!rest.includes("TOOL_CALL"), "the marker itself is consumed")
    assert.ok(rest.includes("好的"), "ordinary words stay ordinary")
    assert.equal(pending, false)

    const dangle = _internal.extractCalls("TOOL_CALL {\"na")
    assert.equal(dangle.calls.length, 0)
    assert.equal(dangle.pending, true, "an unfinished marker is not eaten")

    const nested = _internal.extractCalls('TOOL_CALL {"name":"edit","arguments":{"path":"/x","edits":[{"old":"a}b","new":"c"}]}} END_CALL')
    assert.equal(nested.calls.length, 1, "braces inside arguments do not end the json early")

    const bogus = _internal.extractCalls('TOOL_CALL {not json} END_CALL')
    assert.equal(bogus.calls.length, 0)
    assert.ok(bogus.rest.includes("TOOL_CALL"), "an unparseable marker is shown as text, not swallowed")

    // a tool result is rendered back with its name, and answers continue from it
    const delta = _internal.toolCallDelta(0, { name: "read", arguments: {} }) // registers id->name, like a real turn
    const msgs = [
      { role: "user", content: "读一下 /a.txt" },
      { role: "assistant", content: "", tool_calls: [delta] },
      { role: "tool", tool_call_id: delta.id, content: "文件内容在此" },
    ]
    const p2 = _internal.buildPrompt(msgs)
    assert.ok(p2.includes("TOOL_CALL"), "the model's own call is in the transcript")
    assert.ok(p2.includes("工具 read 的返回结果"), "the result is credited to its tool by name")
    assert.ok(p2.includes("继续回答"), "the ask after a result is to continue, not to restart")

    // a plain assistant sentence mid-turn is not mistaken for history
    const p3 = _internal.buildPrompt([
      { role: "user", content: "问题" },
      { role: "assistant", content: "半截话" },
    ])
    assert.ok(!p3.includes("半截话"))
  }],

  ["the OpenAI chunk is well formed", async () => {
    const chunk = JSON.parse(_internal.openaiChunk("id1", "m", { content: "hi" }).replace(/^data: /, ""))
    assert.equal(chunk.choices[0].delta.content, "hi")
    assert.equal(chunk.choices[0].finish_reason, null)
    const end = JSON.parse(_internal.openaiChunk("id1", "m", {}, "stop").replace(/^data: /, ""))
    assert.equal(end.choices[0].finish_reason, "stop")
  }],

  ["a message reads as text whatever shape it came in", async () => {
    assert.equal(_internal.contentText([{ type: "text", text: "a" }, { type: "image" }, "b"]), "ab")
    assert.equal(_internal.contentText("plain"), "plain")
  }],
]

let failed = 0
for (const [name, fn] of offline) {
  try {
    await fn()
    console.log("✓", name)
  } catch (e) {
    failed++
    console.log("✗", name, "\n  ", e?.message ?? e)
  }
}

// The live turn: only when asked for, and only where the app is installed.
if (process.env.DOUBAO_E2E === "1") {
  console.log("\n--- 真实对话 ---")
  if (!existsSync(_internal.cookieFile())) {
    console.log("! 跳过：没有找到豆包工作的登录文件", _internal.cookieFile())
  } else {
    const hooks = await hooksOf()
    const flow = await hooks.auth.methods[0].authorize()
    const auth = await flow.callback()
    assert.equal(auth.type, "success", "登录失败：" + auth.error)
    console.log("✓ 用本机豆包工作的登录签入：", auth.accountId)

    const loader = await hooks.auth.loader(async () => auth)
    const url = loader.baseURL + "/chat/completions"

    const streamed = await loader.fetch(url, {
      method: "POST",
      body: JSON.stringify({
        model: "doubao-2.1-pro",
        stream: true,
        // A question with one right answer: an empty prompt still gets a
        // polite reply from Doubao, so only a checkable answer proves the
        // text reached the model.
        messages: [{ role: "user", content: "中国的首都是哪里？只回答城市名。" }],
      }),
    })
    assert.equal(streamed.status, 200)
    const raw = await streamed.text()
    const parts = raw
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)))
    const bad = parts.find((p) => p.error)
    assert.ok(!bad, "流里带了错误：" + JSON.stringify(bad?.error))
    const text = parts.map((p) => p.choices?.[0]?.delta?.content ?? "").join("")
    assert.ok(text.trim().length > 0, "没有拿到任何文字")
    assert.match(text, /北京/, "回答里没有预期内容，可能问题没有送达到模型：" + JSON.stringify(text))
    assert.equal(parts.at(-1).choices[0].finish_reason, "stop")
    console.log("✓ 流式：", JSON.stringify(text))

    const single = await loader.fetch(url, {
      method: "POST",
      body: JSON.stringify({
        model: "doubao-2.1-pro",
        stream: false,
        messages: [{ role: "user", content: "1+1 等于几？只回数字。" }],
      }),
    })
    const json = await single.json()
    assert.ok(!json.error, "非流式带了错误：" + JSON.stringify(json.error))
    const plain = json.choices?.[0]?.message?.content ?? ""
    assert.match(plain, /2/, "回答里没有预期内容：" + JSON.stringify(plain))
    console.log("✓ 非流式：", JSON.stringify(plain))

    // The one that matters most for an agent: does the second turn still
    // know what the first said?
    const remember = [{ role: "user", content: "请记住：我的暗号是「紫罗兰」。确认时只回复：收到" }]
    const r1 = await (await loader.fetch(url, {
      method: "POST",
      body: JSON.stringify({ model: "doubao-2.1-pro", stream: false, messages: remember }),
    })).json()
    assert.ok(!r1.error, "第一问失败：" + JSON.stringify(r1.error))

    const r2 = await (await loader.fetch(url, {
      method: "POST",
      body: JSON.stringify({
        model: "doubao-2.1-pro",
        stream: false,
        messages: [
          ...remember,
          { role: "assistant", content: r1.choices[0].message.content },
          { role: "user", content: "我的暗号是什么？只回答暗号本身。" },
        ],
      }),
    })).json()
    assert.ok(!r2.error, "第二问失败：" + JSON.stringify(r2.error))
    const second = r2.choices?.[0]?.message?.content ?? ""
    assert.match(second, /紫罗兰/, "第二轮没接住第一轮：" + JSON.stringify(second))
    console.log("✓ 多轮记忆：", JSON.stringify(second))

    // The whole point of 0.2.0: a real tool round-trip over the emulated
    // protocol, streamed, the way a harness drives it.
    const TOOLS = [{
      type: "function",
      function: { name: "get_weather", description: "查询城市当前天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
    }]
    const q = [{ role: "user", content: "上海今天天气怎么样？用工具查。" }]
    const tr1 = await loader.fetch(url, { method: "POST", body: JSON.stringify({ model: "doubao-2.1-pro", stream: true, tools: TOOLS, messages: q }) })
    const tr1raw = await tr1.text()
    const tr1parts = tr1raw.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const callDeltas = tr1parts.flatMap((p) => p.choices?.[0]?.delta?.tool_calls ?? [])
    assert.equal(tr1parts.at(-1).choices[0].finish_reason, "tool_calls", "回合 1 必须以 tool_calls 收尾：" + JSON.stringify(tr1parts.at(-1)))
    assert.ok(callDeltas.length >= 1, "至少一个 tool_call")
    assert.equal(callDeltas[0].function.name, "get_weather")
    assert.match(callDeltas[0].function.arguments, /上海/, "参数里得带上城市")
    const call = callDeltas[0]
    console.log("✓ 工具回合 1（流式吐调用）：", JSON.stringify(call.function))

    const tr2 = await loader.fetch(url, {
      method: "POST",
      body: JSON.stringify({
        model: "doubao-2.1-pro",
        stream: false,
        tools: TOOLS,
        messages: [
          ...q,
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: JSON.stringify({ city: "上海", temp: "22C", sky: "多云" }) },
        ],
      }),
    })
    const tr2json = await tr2.json()
    assert.ok(!tr2json.error, "回合 2 失败：" + JSON.stringify(tr2json.error))
    const final = tr2json.choices[0].message.content ?? ""
    assert.match(final, /22/, "回答必须用上工具结果：" + JSON.stringify(final))
    console.log("✓ 工具回合 2（喂结果出答案）：", JSON.stringify(final.slice(0, 80)))
  }
}

if (failed) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log("\n全部通过")
