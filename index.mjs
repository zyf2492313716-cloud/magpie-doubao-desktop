// OpenCode & magpie provider plugin for Doubao (豆包), signing in with the
// session the 豆包工作 desktop app already holds.
//
// Nothing is asked of the user: DoubaoWork keeps its sign-in in its own
// Chromium profile, and this reads that profile the way [kimi-work] reads
// Kimi's. Chats then go to Doubao's own endpoints under that session, so no
// gateway, no Docker and no cookie pasting is involved:
//   POST /samantha/thread/create  -> a conversation of its own
//   POST /chat/completion         -> the reply, as an SSE patch stream
//
// Doubao's chat keeps a conversation's history server-side, so one agent
// session is pinned to one Doubao thread: its first turn makes the thread and
// later turns reuse it. Tools are not sent; the chat endpoint has no place for
// them, and a model that can't be handed its tools is listed without them.

import { copyFileSync, existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER = "doubao-free"
const NAME = "Doubao (豆包)"
const HOST = "https://www.doubao.com"
const AID = "492576" // Doubao web's app id, sent on every call
const BOT_ID = "7338286299411103781" // Doubao's default assistant bot
const SESSION_MS = 5 * 60 * 1000 // how long a read sign-in is kept before it's read again
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"

// Doubao's own model menu, read out of 豆包工作's cached config
// (Default/Preferences -> frontend-request-cache -> modeSelectData). The keys
// are what the app sends as ext.model_item_key; 256000 is the
// total_window_size the app declares for all three, not something measured
// from here. None of them is listed with tool calling: the chat endpoint has
// nowhere to put a tool declaration.
const MODELS = [
  { id: "auto", name: "自动 · 豆包", key: "9", context: 256000, efforts: [3, 4, 5] },
  { id: "doubao-2.1-pro", name: "豆包 2.1 Pro", key: "5", context: 256000, efforts: [3, 4, 5] },
  { id: "doubao-2.1-lite", name: "豆包 2.1 Lite", key: "seed-lite-7b", context: 256000, efforts: [3, 4, 5] },
]

// 低 / 中 / 高, the three levels the app offers; the app's own default is 5.
// It is forwarded as the app sends it, but it changes only how the answer
// reads, since none of it comes back as a separate reasoning stream.
const DEFAULT_EFFORT = 5
const EFFORTS = new Set([3, 4, 5])

function effortFor(body) {
  const e = body?.reasoningEffort ?? body?.reasoning_effort
  const n = typeof e === "string" ? { low: 3, medium: 4, high: 5 }[e] ?? Number(e) : Number(e)
  return EFFORTS.has(n) ? n : DEFAULT_EFFORT
}

function modelById(id) {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]
}

function modelMap() {
  return Object.fromEntries(
    MODELS.map((m) => [
      m.id,
      {
        name: m.name,
        limit: { context: m.context, output: 16000 },
        // No separate reasoning stream. Asked to show its work, the reply
        // came back as 527 content deltas and nothing else: every patch was
        // patch_object 102 with content.text_block, with no thinking channel
        // beside it. Saying `reasoning: true` here would only earn magpie an
        // empty thinking pane, so it says false and the reasoning stays in
        // the text where it arrives.
        reasoning: false,
        tool_call: false,
      },
    ]),
  )
}

// ---- the desktop app's own sign-in ---------------------------------------

// Where 豆包工作 keeps its profile, per platform.
function profileDir() {
  const home = homedir()
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "DoubaoWork")
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "DoubaoWork")
  return join(home, ".config", "DoubaoWork")
}

function cookieFile() {
  return join(profileDir(), "Default", "Cookies")
}

// The secret Chromium derives its cookie key from. Only the macOS Keychain
// entry is read here; elsewhere the app's profile is encrypted by other means
// this plugin doesn't attempt.
async function safeStoragePassword() {
  if (process.platform !== "darwin") {
    throw new Error("读取本机豆包工作的登录目前只支持 macOS，请在 Mac 上打开豆包工作后使用")
  }
  const { execFileSync } = await import("node:child_process")
  let out
  try {
    out = execFileSync("/usr/bin/security", ["find-generic-password", "-w", "-s", "DoubaoWork Browser Safe Storage"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    throw new Error("钥匙串里没有「DoubaoWork Browser」的条目，请先安装并登录豆包工作")
  }
  const pass = out.replace(/\r?\n$/, "")
  if (!pass) throw new Error("钥匙串拒绝了豆包工作的密钥，请在系统弹窗里允许后重试")
  return pass
}

// The app holds Cookies open, so it's copied aside and the copy is read; the
// copy is dropped again whatever happens.
async function readCookieRows() {
  const src = cookieFile()
  if (!existsSync(src)) throw new Error(`没有豆包工作的登录文件：${src}\n请先安装并登录豆包工作（DoubaoWork）`)
  const tmp = src + ".magpie-doubao.tmp"
  copyFileSync(src, tmp)
  try {
    return await readCookieRowsFrom(tmp)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {}
  }
}

async function readCookieRowsFrom(path) {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite")
    const db = new Database(path, { readonly: true })
    try {
      return db
        .query('SELECT name, encrypted_value AS value FROM cookies WHERE host_key LIKE "%doubao%"')
        .all()
        .map((r) => ({ name: r.name, value: Buffer.from(r.value) }))
    } finally {
      db.close()
    }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db
      .prepare('SELECT name, encrypted_value AS value FROM cookies WHERE host_key LIKE "%doubao%"')
      .all()
      .map((r) => ({ name: r.name, value: Buffer.from(r.value) }))
  } finally {
    db.close()
  }
}

// Chromium on macOS stores "v10"-prefixed AES-128-CBC values; the plaintext is
// a 32-byte device binding, then the cookie's own bytes.
async function readSession() {
  const { pbkdf2Sync, createDecipheriv } = await import("node:crypto")
  const key = pbkdf2Sync(await safeStoragePassword(), "saltysalt", 1003, 16, "sha1")
  const rows = await readCookieRows()
  const iv = Buffer.alloc(16, 0x20)
  const cookies = {}
  for (const row of rows) {
    const enc = Buffer.from(row.value)
    if (enc.subarray(0, 3).toString() !== "v10") continue
    const decipher = createDecipheriv("aes-128-cbc", key, iv)
    const plain = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()])
    const value = plain.subarray(32).toString("latin1").replace(/[^\x20-\x7e]/g, "").trim()
    if (value) cookies[row.name] = value
  }
  if (!cookies.sessionid) throw new Error("豆包工作里没有可用的登录，请打开豆包工作登录后再试")
  return cookies
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ")
}

function headersFor(cookies, extra = {}) {
  return {
    Cookie: cookieHeader(cookies),
    "User-Agent": UA,
    "Content-Type": "application/json",
    Referer: `${HOST}/chat/`,
    Origin: HOST,
    ...extra,
  }
}

// Doubao's edge drops sockets now and then (seen as ECONNRESET on
// thread/create). One retry covers it; anything past that is reported as it
// came rather than retried into a hang.
const FLAKY = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket connection was closed|fetch failed|network error/i
async function withRetry(fn, tries = 2, ms = 500) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!FLAKY.test(String(e?.message ?? e)) || i === tries - 1) throw e
      await new Promise((r) => setTimeout(r, ms * (i + 1)))
    }
  }
  throw last
}

// ---- Doubao's endpoints ---------------------------------------------------

async function callDoubao(cookies, path, body, signal) {
  const res = await fetch(HOST + path, {
    method: "POST",
    headers: headersFor(cookies),
    body: JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`豆包 ${path} 返回了非 JSON（HTTP ${res.status}）`)
  }
  if (json.code !== 0) {
    const err = new Error(`豆包 ${path}: ${json.msg || json.message || "失败"}（code ${json.code}）`)
    err.status = res.status
    err.code = json.code
    throw err
  }
  return json.data
}

const createThread = (cookies, signal) =>
  callDoubao(cookies, "/samantha/thread/create", { conversation_type: 1, bot_id: BOT_ID }, signal).then(
    (d) => String(d?.thread_info?.conversation?.conversation_id ?? ""),
  )

// The account behind a session, for the card's title. Null means Doubao
// answered and said the session is no good. A throw means it couldn't be
// asked, which is not the same thing and must not be reported as an expired
// login.
async function whoami(cookies, signal) {
  const res = await fetch(`${HOST}/passport/account/info/v2/?aid=${AID}`, {
    headers: { Cookie: cookieHeader(cookies), "User-Agent": UA, Referer: `${HOST}/chat/` },
    signal,
  })
  if (!res.ok) throw new Error(`豆包账号检查 HTTP ${res.status}`)
  const j = await res.json().catch(() => null)
  if (!j || typeof j !== "object") throw new Error("豆包账号检查没有返回 JSON")
  const d = j?.data ?? {}
  if (!d.user_id) return null
  return { id: String(d.user_id), name: d.name || d.description || "" }
}

// The account id Doubao also keeps in the app's own cookies, for when the
// check above couldn't be made.
function accountIdFrom(cookies) {
  const m = /^(\d{6,}):/.exec(cookies.multi_sids ?? "")
  return m ? m[1] : ""
}

// One turn. Doubao answers as SSE; the STREAM_CHUNK patches carry the text
// under patch_object 102, whose value is itself a JSON string. A reply short
// enough to arrive at once carries no patch, and comes in the final
// STREAM_MSG_NOTIFY block instead, so that is kept and used if nothing was
// patched.
function textBlock(text) {
  return {
    block_type: 10000, // BLOCK_TEXT
    content: { text_block: { text, icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" },
    block_id: String(Math.floor(Math.random() * 1e10)),
    parent_id: "",
    meta_info: [],
    extra_info: {},
    append_fields: [],
  }
}

// What has been handed out so far. The two channels of a reply are
// complementary, not redundant: the accumulated block carries the text up to
// the moment it was sent, and the patches carry what came after it. A short
// reply really does arrive as a block of one character and a patch for the
// next, so neither channel can be dropped and neither may be counted twice.
function newAccumulator() {
  let emitted = ""
  return {
    get text() {
      return emitted
    },
    acceptPatch(text) {
      if (typeof text !== "string" || !text) return null
      emitted += text
      return text
    },
    acceptWhole(text) {
      if (typeof text !== "string" || !text) return null
      if (text.startsWith(emitted)) {
        const add = text.slice(emitted.length)
        emitted = text
        return add || null
      }
      if (emitted.startsWith(text)) return null // behind what the patches sent
      return null // unlike what was sent; the patches are the live view
    },
  }
}

async function* streamCompletion(cookies, conversationId, prompt, modelKey, effort, signal) {
  const uid = crypto.randomUUID()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"
  const body = {
    client_meta: {
      local_conversation_id: "local-" + uid,
      conversation_id: String(conversationId),
      bot_id: BOT_ID,
      last_section_id: "",
      last_message_index: 0,
      local_permissions: [],
    },
    messages: [
      {
        local_message_id: uid,
        unique_id: uid,
        user_type: "HUMAN",
        create_time: Date.now(),
        content_block: [textBlock(prompt)],
        message_status: 1,
        // How 豆包工作 itself names the model it wants and how hard it should
        // think; both go in the message's ext, and again in the conversation's
        // init options when the conversation is this plugin's own.
        ext: { is_finish: "1", ...(modelKey ? { model_item_key: modelKey } : {}), ...(effort ? { reasoning_effort: String(effort) } : {}) },
      },
    ],
    option: {
      send_message_scene: "",
      create_time_ms: Date.now(),
      ...(modelKey || effort ? { conversation_init_ext: { ...(modelKey ? { model_item_key: modelKey } : {}), ...(effort ? { reasoning_effort: String(effort) } : {}) } } : {}),
    },
  }
  const res = await withRetry(() =>
    fetch(`${HOST}/chat/completion?tz_name=${encodeURIComponent(timeZone)}&aid=${AID}`, {
      method: "POST",
      headers: headersFor(cookies, { Accept: "text/event-stream" }),
      body: JSON.stringify(body),
      signal,
    }),
  )
  if (!res.ok || !res.body) {
    const err = new Error(`豆包 chat/completion HTTP ${res.status}`)
    err.status = res.status
    throw err
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let ended = false
  const acc = newAccumulator()
  try {
    while (!ended) {
      let chunk
      try {
        chunk = await reader.read()
      } catch (e) {
        // The caller hanging up is not a failed reply: magpie cancels a
        // stream it no longer wants, and that arrives as an AbortError here.
        if (e?.name === "AbortError") break
        throw e
      }
      const { value, done } = chunk
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, cut)
        buf = buf.slice(cut + 2)
        const event = /event:\s*(\S+)/.exec(raw)?.[1] ?? ""
        const data = (/data:\s*([\s\S]*)/.exec(raw)?.[1] ?? "").trim()
        if (!data) continue
        let json
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        if (event === "STREAM_ERROR") {
          throw Object.assign(new Error(`豆包流式错误 ${json.error_code ?? ""}：${json.error_msg ?? "未知"}`), {
            streamError: true,
          })
        }
        if (event === "STREAM_CHUNK") {
          for (const op of json.patch_op ?? []) {
            if (op.patch_object !== 102 || typeof op.patch_value?.content !== "string") continue
            let piece
            try {
              piece = JSON.parse(op.patch_value.content)
            } catch {
              continue
            }
            const add = acc.acceptPatch(piece.text)
            if (add) yield add
          }
        } else if (event === "STREAM_MSG_NOTIFY") {
          // The same reply also arrives here as one accumulated block, in one
          // of the shapes the endpoint has been seen to use. It is what a
          // reply that never patched has, and it is what says how far the
          // patches have actually gone.
          const c = json?.content
          if (!c) continue
          const candidates = []
          if (typeof c.model_content === "string") candidates.push(c.model_content)
          if (typeof c.content === "string") {
            try {
              const parsed = JSON.parse(c.content)
              if (typeof parsed?.text === "string") candidates.push(parsed.text)
            } catch {
              candidates.push(c.content)
            }
          }
          for (const block of c.content_block ?? []) {
            const text = block?.content?.text_block?.text
            if (typeof text === "string") candidates.push(text)
          }
          for (const t of candidates) {
            if (t.trim() === prompt.trim()) continue // an echo of the question
            const add = acc.acceptWhole(t)
            if (add) yield add
          }
        } else if (event === "SSE_REPLY_END" && json.end_type === 3) {
          ended = true
        }
      }
    }
  } finally {
    try {
      reader.cancel()
    } catch {}
  }
}

// ---- an OpenAI request mapped onto a Doubao thread -----------------------

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : "")).join("")
}

// How many non-text parts (images, documents) a message carried, so the model
// can be told they didn't arrive instead of guessing at them.
function droppedParts(content) {
  if (!Array.isArray(content)) return 0
  return content.filter((p) => typeof p === "object" && p && p.type !== "text").length
}

// A harness bolts its own state onto the conversation as extra user text: this
// run's clock, the browser's time zone, reminders it injected. None of it is
// something the user asked, and leaving it in made the model answer the
// timestamp instead of the request. Matched on the shape of those blocks,
// which covers what the harnesses on this machine send; anything else stays.
const HARNESS_BLOCKS = [
  /^Current runtime context\.[\s\S]*?(?=\n\n|$)/gm,
  /^Time sampled while preparing turn[^\n]*\n(?:[^\n]*\n){0,4}/gm,
  /^Browser time zone for this request:[^\n]*\n(?:[^\n]*\n){0,2}/gm,
  /^Elapsed since the preceding[^\n]*\n?/gm,
  /^<system-reminder>[\s\S]*?<\/system-reminder>\n?/gm,
  /^\s*\[[a-z][a-z0-9- ]{2,30}\]\s*$/gm,
]

function stripHarnessNoise(text) {
  let out = text
  for (const re of HARNESS_BLOCKS) out = out.replace(re, "")
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

// Consecutive turns from one side are one turn: a harness that sends the ask
// and then its own context block as two user messages shouldn't read as two
// questions.
function mergeTurns(messages) {
  const merged = []
  for (const m of messages) {
    if (m?.role !== "user" && m?.role !== "assistant") continue
    const text = stripHarnessNoise(contentText(m.content))
    if (!text) continue
    const last = merged.at(-1)
    if (last && last.role === m.role) last.text += "\n\n" + text
    else merged.push({ role: m.role, text, dropped: droppedParts(m.content) })
  }
  return merged
}

// What Doubao is asked. Its chat keeps history on the server, but a request
// from here isn't given that history: two turns in the same conversation were
// checked, and the second one forgot the first. So the turns the agent already
// had are sent along as a transcript, which was checked to work.
// The system prompt is left out — it's the harness's own boilerplate, not
// something of the conversation's, and it would be paid for on every turn.
const TRANSCRIPT_CAP = 6000 // characters of history, newest kept first

function buildPrompt(messages) {
  let turns = mergeTurns(messages)
  // A harness that appends its own context after the assistant's reply leaves
  // the conversation ending on the assistant once that context is stripped.
  // The ask is still the last thing the user said, so go back to it and drop
  // whatever came after.
  const lastUser = turns.map((t) => t.role).lastIndexOf("user")
  if (lastUser < 0) return ""
  turns = turns.slice(0, lastUser + 1)
  const question = turns.at(-1)

  const note = question.dropped
    ? `\n（注意：用户这条消息里带了 ${question.dropped} 个图片或文件附件，这个通道传不过去，你看不到它们的内容；需要的话直接跟用户说你看不到，别猜。）`
    : ""

  if (turns.length === 1) return question.text + note

  const kept = []
  let used = question.text.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = `${turns[i].role === "user" ? "用户" : "助手"}：${turns[i].text}`
    if (kept.length && used + line.length > TRANSCRIPT_CAP) break
    kept.unshift(line)
    used += line.length
  }
  if (kept.length <= 1) return question.text + note
  return `以下是此前的对话：\n${kept.join("\n")}\n请回答用户最后一条消息。${note}`
}

function lastUserText(messages) {
  const turns = mergeTurns(messages)
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "user") return turns[i].text
  return ""
}

function openaiChunk(id, model, delta, finish) {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    }) +
    "\n\n"
  )
}

function jsonError(message, type, status) {
  return new Response(JSON.stringify({ error: { message, type, code: null, param: null } }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function makePlugin() {
  return async () => {
    // One Doubao conversation for this process, started when first needed and
    // turned over every TURNS_PER_THREAD turns so it doesn't grow without end
    // in the user's own Doubao list.
    let thread = null
    let turns = 0
    const TURNS_PER_THREAD = 40
    let held = null // the sign-in read last, so a turn doesn't re-open the file

    const session = async () => {
      if (held && Date.now() - held.at < SESSION_MS) return held
      held = { cookies: await readSession(), at: Date.now() }
      return held
    }

    return {
      config: async (config) => {
        config.provider ??= {}
        config.provider[PROVIDER] ??= {}
        const p = config.provider[PROVIDER]
        p.name ??= NAME
        p.npm ??= "@ai-sdk/openai-compatible"
        // A base of its own: every call is answered by the fetch below, so
        // nothing is ever sent to this host.
        p.api ??= HOST + "/magpie-doubao/v1"
        p.models = { ...modelMap(), ...(p.models ?? {}) }
      },

      provider: {
        id: PROVIDER,
        async models(provider) {
          return provider?.models ?? modelMap()
        },
      },

      auth: {
        provider: PROVIDER,
        single: true,
        maxConcurrency: 2,
        methods: [
          {
            type: "oauth",
            label: "使用本机豆包工作的登录",
            async authorize() {
              return {
                url: "",
                method: "auto",
                instructions: "读取本机「豆包工作」桌面端的登录；不改动它的账号，也不写它的文件。",
                async callback() {
                  let cookies
                  try {
                    cookies = await readSession()
                  } catch (e) {
                    return { type: "failed", error: e?.message ?? String(e) }
                  }
                  let who = null
                  let asked = true
                  try {
                    who = await whoami(cookies)
                  } catch {
                    asked = false // couldn't ask; the sign-in itself is still in hand
                  }
                  if (asked && !who) {
                    return { type: "failed", error: "豆包工作的登录已过期，请打开豆包工作重新登录后再试。" }
                  }
                  held = { cookies, at: Date.now() }
                  const uid = who?.id || accountIdFrom(cookies)
                  return {
                    type: "success",
                    access: "",
                    refresh: "",
                    expires: 0,
                    source: "doubao-work-desktop",
                    accountId: who?.name || (uid ? `豆包 · ${uid.slice(0, 6)}` : NAME),
                    uid,
                  }
                },
              }
            },
          },
        ],

        loader: async (getAuth) => {
          const auth = await getAuth()
          if (auth?.source !== "doubao-work-desktop") return {}

          return {
            baseURL: HOST + "/magpie-doubao/v1",
            apiKey: "doubao-work-desktop",
            async fetch(input, init) {
              const req = input instanceof Request ? input : null
              const url = req ? req.url : String(input)
              const method = (init?.method ?? req?.method ?? "POST").toUpperCase()
              const signal = init?.signal ?? req?.signal ?? undefined

              let body
              try {
                const raw = init?.body ?? (req ? await req.clone().text() : "")
                body = raw ? JSON.parse(raw) : {}
              } catch {
                return jsonError("豆包插件只接受 JSON 请求体", "invalid_request_error", 400)
              }

              if (method === "GET" && /\/models\/?$/.test(url)) {
                return new Response(
                  JSON.stringify({
                    object: "list",
                    data: MODELS.map((m) => ({ id: m.id, object: "model", owned_by: "doubao" })),
                  }),
                  { headers: { "Content-Type": "application/json" } },
                )
              }

              if (!/\/chat\/completions\/?$/.test(url)) {
                return jsonError(`豆包插件不服务这个端点：${url}`, "invalid_request_error", 404)
              }

              const messages = Array.isArray(body.messages) ? body.messages : []
              const prompt = buildPrompt(messages)
              if (!prompt) return jsonError("豆包插件需要一个 user 消息", "invalid_request_error", 400)

              let cookies
              try {
                cookies = (await session()).cookies
              } catch (e) {
                return jsonError(e?.message ?? String(e), "authentication_error", 401)
              }

              if (!thread || turns >= TURNS_PER_THREAD) {
                try {
                  const made = await withRetry(() => createThread(cookies, signal))
                  if (!made) throw new Error("豆包没有返回会话 id")
                  thread = made
                  turns = 0
                } catch (e) {
                  const msg = e?.message ?? String(e)
                  const expired = /401|过期|login|登录/i.test(msg)
                  held = null // the next turn reads the app's sign-in again
                  return jsonError(
                    expired ? `豆包登录已过期：${msg}` : `豆包新建会话失败：${msg}`,
                    expired ? "authentication_error" : "api_error",
                    expired ? 401 : 502,
                  )
                }
              }
              const conversationId = thread
              turns++

              const id = "chatcmpl-" + conversationId
              const chosen = modelById(body.model)
              const model = typeof body.model === "string" && body.model ? body.model : chosen.id

              if (body.stream === false) {
                let text = ""
                try {
                  for await (const piece of streamCompletion(cookies, conversationId, prompt, chosen.key, effortFor(body), signal)) text += piece
                } catch (e) {
                  thread = null // a fresh conversation next time
                  return jsonError(e?.message ?? String(e), "api_error", 502)
                }
                return new Response(
                  JSON.stringify({
                    id,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                  }),
                  { headers: { "Content-Type": "application/json" } },
                )
              }

              const stream = new ReadableStream({
                async start(controller) {
                  const enc = new TextEncoder()
                  // The consumer may have gone away; enqueuing into a closed
                  // stream must not turn a finished reply into an error.
                  const send = (s) => {
                    try {
                      controller.enqueue(enc.encode(s))
                    } catch {}
                  }
                  try {
                    send(openaiChunk(id, model, { role: "assistant" }))
                    let any = false
                    for await (const piece of streamCompletion(cookies, conversationId, prompt, chosen.key, effortFor(body), signal)) {
                      any = true
                      send(openaiChunk(id, model, { content: piece }))
                    }
                    if (!any) send(openaiChunk(id, model, { content: "" }))
                    send(openaiChunk(id, model, {}, "stop"))
                    send("data: [DONE]\n\n")
                  } catch (e) {
                    thread = null // a fresh conversation next time
                    if (e?.name === "AbortError") {
                      try {
                        controller.close()
                      } catch {}
                      return
                    }
                    send(
                      "data: " +
                        JSON.stringify({ error: { message: e?.message ?? String(e), type: "api_error" } }) +
                        "\n\n",
                    )
                  }
                  try {
                    controller.close()
                  } catch {}
                },
              })

              return new Response(stream, {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                },
              })
            },
          }
        },
      },
    }
  }
}

export const DoubaoDesktopPlugin = makePlugin()

// for tests
export const _internal = {
  PROVIDER,
  HOST,
  AID,
  BOT_ID,
  MODELS,
  modelMap,
  modelById,
  effortFor,
  mergeTurns,
  stripHarnessNoise,
  cookieHeader,
  contentText,
  lastUserText,
  buildPrompt,
  openaiChunk,
  textBlock,
  newAccumulator,
  profileDir,
  cookieFile,
  headersFor,
}
