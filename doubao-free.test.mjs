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
    assert.equal(p.models["doubao-2.1-pro"].tool_call, false, "tools are not sent")
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
  }
}

if (failed) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log("\n全部通过")
