#!/usr/bin/env node
require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

// ========= 配置 =========
const PORT = Number(process.env.PORT || 3100);
const WALLETS_FILE = path.join(process.cwd(), "wallets.json");
const API_KEY = process.env.API_KEY || "";

const TG_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_ALLOWED = String(process.env.TELEGRAM_ALLOWED_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// ========= 小工具 =========
const isValidAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(String(s).trim());
const normAddr = (s) => "0x" + String(s).trim().replace(/^0x/,"").toLowerCase();

// 标准化为 [{address,label}]
function toWalletList(any) {
  if (Array.isArray(any)) {
    return any.map(item => {
      if (typeof item === "string") return { address: normAddr(item), label: "" };
      if (item && typeof item === "object" && item.address) {
        return { address: normAddr(item.address), label: String(item.label||"").trim() };
      }
      return null;
    }).filter(Boolean);
  }
  if (any && typeof any === "object") {
    // 也兼容映射 { "0x..": "备注" }
    return Object.entries(any).map(([addr,label]) => ({ address: normAddr(addr), label: String(label||"").trim() }));
  }
  return [];
}

// 简单异步互斥，避免并发写
let writeLock = Promise.resolve();
function withLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => {}); // 防止中断链
  return next;
}

// 原子写入：写 .tmp 再 rename
async function atomicWrite(file, content) {
  const tmp = `${file}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

// 读 wallets.json（自动迁移为对象数组）
async function readWallets() {
  try {
    let s = await fs.readFile(WALLETS_FILE, "utf8");
    s = s.replace(/^\uFEFF/, "").trim();   // 去掉 BOM
    if (s === "") return [];

    try {
      return toWalletList(JSON.parse(s));
    } catch {
      // 兼容“逐行/空格/逗号分隔”的原始地址文件
      const addrs = (s.match(/0x[a-fA-F0-9]{40}/g) || []).map(a => ({ address: normAddr(a), label: "" }));
      if (addrs.length) {
        await atomicWrite(WALLETS_FILE, JSON.stringify(addrs, null, 2));
        console.log(`🔧 已把 ${WALLETS_FILE} 迁移为对象数组（含 label）`);
        return addrs;
      }
      throw new Error("wallets.json 格式无效");
    }
  } catch (e) {
    if (e.code === "ENOENT") { await atomicWrite(WALLETS_FILE, "[]"); return []; }
    throw e;
  }
}

async function writeWallets(list) {
  const arr = toWalletList(list);
  // 去重：按 address 唯一，保留最后一个的 label
  const map = new Map(arr.map(w => [w.address, String(w.label||"").trim()]));
  const normalized = [...map.entries()].map(([address,label]) => ({ address, label }));
  await atomicWrite(WALLETS_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

async function addWallets(input) {
  const items = toWalletList(input);
  if (!items.length) return { added: [], skipped: [], all: await readWallets() };

  return withLock(async () => {
    const cur = await readWallets(); // [{address,label}]
    const map = new Map(cur.map(w => [w.address, w.label]));
    const added = [], skipped = [];
    for (const w of items) {
      if (map.has(w.address)) skipped.push(w.address);
      else { map.set(w.address, w.label || ""); added.push(w.address); }
    }
    const all = await writeWallets([...map.entries()].map(([address,label]) => ({address,label})));
    return { added, skipped, all };
  });
}

async function delWallets(addresses) {
  const list = (addresses || []).filter(isValidAddr).map(normAddr);
  if (!list.length) return { removed: [], notFound: [], all: await readWallets() };

  return withLock(async () => {
    const cur = await readWallets();
    const map = new Map(cur.map(w => [w.address, w.label]));
    const removed = [], notFound = [];
    for (const a of list) {
      if (map.has(a)) { map.delete(a); removed.push(a); }
      else notFound.push(a);
    }
    const all = await writeWallets([...map.entries()].map(([address,label]) => ({address,label})));
    return { removed, notFound, all };
  });
}

async function setLabel(address, label="") {
  if (!isValidAddr(address)) throw new Error("invalid address");
  address = normAddr(address);
  return withLock(async () => {
    const cur = await readWallets();
    const map = new Map(cur.map(w => [w.address, w.label]));
    if (!map.has(address)) throw new Error("address not found");
    map.set(address, String(label||"").trim());
    const all = await writeWallets([...map.entries()].map(([a,l]) => ({address:a,label:l})));
    return { address, label: map.get(address), all };
  });
}

// ========= 启动 API =========
const app = express();
app.use(express.json());

function auth(req, res, next) {
  if (!API_KEY) return next();
  const k = req.headers["x-api-key"];
  if (k === API_KEY) return next();
  res.status(401).json({ ok:false, error:"unauthorized" });
}

app.get("/health", (_,res)=>res.json({ ok:true }));

// GET：返回 [{address,label}]
app.get("/api/wallets", auth, async (_, res) => {
  const all = await readWallets();
  res.json({ ok:true, count: all.length, wallets: all });
});

// POST /api/wallets
// body 支持：{ address, label } 或 { wallets:[{address,label},...] } 或 { addresses:["0x..", ...] }
app.post("/api/wallets", auth, async (req, res) => {
  const { address, label, wallets, addresses } = req.body || {};
  const list = wallets ? wallets : (addresses ? addresses : (address ? [{address, label}] : []));
  const result = await addWallets(list);
  res.json({ ok:true, ...result });
});

// DELETE /api/wallets  { address:"0x.."} 或 {addresses:[...]}
app.delete("/api/wallets", auth, async (req, res) => {
  const { address, addresses } = req.body || {};
  const list = addresses || (address ? [address] : []);
  const result = await delWallets(list);
  res.json({ ok:true, ...result });
});

// 单个路径版：DELETE /api/wallets/0xabc...
app.delete("/api/wallets/:address", auth, async (req, res) => {
  const a = req.params.address;
  if (!isValidAddr(a)) return res.status(400).json({ ok:false, error:"invalid address" });
  const result = await delWallets([a]);
  res.json({ ok:true, ...result });
});

// PATCH /api/wallets  { address, label } 或 { labels: {"0x..":"备注", ...} }
app.patch("/api/wallets", auth, async (req, res) => {
  const { address, label, labels } = req.body || {};
  try {
    if (labels && typeof labels === "object") {
      for (const [a,l] of Object.entries(labels)) await setLabel(a, l);
      const all = await readWallets();
      return res.json({ ok:true, updated: Object.keys(labels).length, wallets: all });
    }
    if (address) {
      const r = await setLabel(address, label || "");
      return res.json({ ok:true, ...r });
    }
    res.status(400).json({ ok:false, error:"missing address/labels" });
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

const server = app.listen(PORT, () => {
  const actual = server.address().port;
  console.log(`HTTP API listening on :${actual}`);
  console.log(`- GET    /api/wallets`);
  console.log(`- POST   /api/wallets   {address[,label]} | {wallets:[{address,label}]} | {addresses:[...]}`);
  console.log(`- DELETE /api/wallets   {address | addresses}  or  /api/wallets/:address`);
  console.log(`- PATCH  /api/wallets   {address,label}  or  {labels:{addr:label}}`);
});

// ========= Telegram Bot =========
if (!TG_TOKEN) {
  console.log("⚠️ 未配置 TELEGRAM_BOT_TOKEN / TG_BOT_TOKEN，跳过机器人。");
} else {
  const bot = new TelegramBot(TG_TOKEN, { polling: true });

  // 允许的用户
  const isAllowed = (msg) => {
    const id = String(msg.from?.id || "");
    return TG_ALLOWED.length ? TG_ALLOWED.includes(id) : true;
  };
  const deny = (msg) => bot.sendMessage(msg.chat.id, "❌ 你无权使用此机器人");

  // 注册菜单（全局 commands）
  bot.setMyCommands([
    { command: 'start',  description: '启动/帮助' },
    { command: 'help',   description: '帮助' },
    { command: 'add',    description: '添加：/add 0x..[=备注] [0x..[=备注]]' },
    { command: 'del',    description: '删除：/del 0x.. [0x..]' },
    { command: 'label',  description: '设置备注：/label 0x.. 备注（留空清除）' },
    { command: 'list',   description: '列出地址' },
    { command: 'whoami', description: '查看你的 Telegram ID' },
  ]).then(()=>console.log('✅ Telegram commands 已设置'))
    .catch(e=>console.error('setMyCommands 错误：', e));

  // —— 工具：宽松指令匹配 & 地址解析 ——
  const CMD = (name) => new RegExp(`^\\/${name}(?:@\\w+)?(?:\\s|$)`, 'i');
  // 解析 0x..=备注 或 仅 0x..
  const extractAddrPairs = (text="") => {
    const pairs = [];
    const reEq = /(0x[a-fA-F0-9]{40})\s*=\s*([^\n,]+)(?=,|\s0x|$)/g;
    let m; while ((m = reEq.exec(text))) pairs.push({ address: m[1], label: m[2].trim() });
    const covered = new Set(pairs.map(p => normAddr(p.address)));
    const reAddr = /0x[a-fA-F0-9]{40}/g;
    let n; while ((n = reAddr.exec(text))) {
      const a = normAddr(n[0]);
      if (!covered.has(a)) pairs.push({ address: a, label: "" });
    }
    if (pairs.length === 1 && pairs[0].label === "") {
      const idx = text.indexOf(pairs[0].address);
      if (idx >= 0) {
        const tail = text.slice(idx + pairs[0].address.length).trim();
        if (tail) pairs[0].label = tail;
      }
    }
    return pairs.filter(p => isValidAddr(p.address));
  };

  // /start /help
  const helpText =
`可用命令：
/add 0x..[=备注] [0x..[=备注]]  - 添加（可多个）
/del 0x.. [0x..]               - 删除
/label 0x.. 备注               - 修改备注（留空清除）
/list                          - 查看
/whoami                        - 查看你的 Telegram ID`;
  bot.onText(CMD('start'), (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    bot.sendMessage(msg.chat.id, helpText, {
      reply_markup: {
        keyboard: [[{text:'/list'}, {text:'/whoami'}],[{text:'/add '}, {text:'/del '}]],
        resize_keyboard: true, one_time_keyboard: false
      }
    });
  });
  bot.onText(CMD('help'),  (msg) => isAllowed(msg) ? bot.sendMessage(msg.chat.id, helpText) : deny(msg));

  // /whoami
  bot.onText(CMD('whoami'), (msg) => bot.sendMessage(msg.chat.id, `你的 Telegram ID: ${msg.from?.id}`));

  // /list（显示 备注 - 地址，自动分段）
  bot.onText(CMD('list'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    try {
      const all = await readWallets(); // [{address,label}]
      if (!all.length) return bot.sendMessage(msg.chat.id, "（空）");
      let buf = "";
      for (const w of all) {
        const line = (w.label ? `${w.label} - ${w.address}` : w.address) + "\n";
        if ((buf.length + line.length) > 3500) { await bot.sendMessage(msg.chat.id, buf); buf = ""; }
        buf += line;
      }
      if (buf) await bot.sendMessage(msg.chat.id, buf);
    } catch (e) {
      console.error("/list 发送失败：", e);
      bot.sendMessage(msg.chat.id, "⚠️ 列表发送失败，请稍后重试。");
    }
  });

  // /add
  bot.onText(CMD('add'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    const pairs = extractAddrPairs(msg.text);
    if (!pairs.length) return bot.sendMessage(msg.chat.id, "用法：/add 0x..[=备注] [0x..[=备注]]");
    const { added, skipped, all } = await addWallets(pairs);
    bot.sendMessage(msg.chat.id, `✅ 已添加: ${added.length}\n↺ 已存在: ${skipped.length}\n当前总数: ${all.length}`);
  });

  // /del
  bot.onText(CMD('del'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    const addrs = (msg.text.match(/0x[a-fA-F0-9]{40}/g) || []).map(normAddr);
    if (!addrs.length) return bot.sendMessage(msg.chat.id, "用法：/del 0x.. [0x..]");
    const { removed, notFound, all } = await delWallets(addrs);
    bot.sendMessage(msg.chat.id, `🗑️ 已删除: ${removed.length}\n❓ 不存在: ${notFound.length}\n当前总数: ${all.length}`);
  });

  // /label 0x.. 备注（留空=清除）
  bot.onText(CMD('label'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    const addr = (msg.text.match(/0x[a-fA-F0-9]{40}/) || [])[0];
    if (!addr) return bot.sendMessage(msg.chat.id, "用法：/label 0x.. 备注（留空清除）");
    const idx = msg.text.indexOf(addr);
    const label = idx >= 0 ? msg.text.slice(idx + addr.length).trim() : "";
    try {
      await setLabel(addr, label);
      bot.sendMessage(msg.chat.id, `✅ 已更新备注：${label || "（清除）"}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ 失败：${String(e.message || e)}`);
    }
  });

  // 调试：看到原始文本
  bot.on('message', (msg) => { if (msg.text) console.log('👀 收到消息：', msg.text); });

  bot.on("polling_error", (e) => console.error("Polling error:", e.message || e));
  console.log("🤖 Telegram bot 已启动");
}
