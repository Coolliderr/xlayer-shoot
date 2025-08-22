// listen-trade.js
// 依赖：npm i ws   （如 Node<18 还需：npm i node-fetch）
require('dotenv').config({ override: true });
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

/* ===================== 配置 ===================== */
const WSS         = process.env.WSS || "wss://xlayerws.okx.com";
const PING_MS     = 20_000;
const MAX_BACKOFF = 30_000;
const WALLETS_FILE = path.join(__dirname, "wallets.json");

// WOKB（XLayer）
const WOKB_ADDR     = "0xe538905cf8410324e03a5a23c1c177a474d59b2b";
const WOKB_DECIMALS = 18;
const ZERO_ADDR     = "0x" + "0".repeat(40);

// === 价格：从环境变量读取，支持 "190" / "190.25" / "190n" ===
const WOKB_PRICE_ENV = (process.env.WOKB_PRICE || "190").trim().toLowerCase();
function parsePriceToMicros(s) {
  const v = s.endsWith("n") ? s.slice(0, -1) : s;
  const m = v.match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) return 190_000_000n;                    // 回退 190.000000
  const int  = m[1];
  const frac = (m[2] || "").padEnd(6, "0").slice(0, 6);
  return BigInt(int + frac);                      // ×1e6
}
const WOKB_PRICE_6  = parsePriceToMicros(WOKB_PRICE_ENV); // USD/WOKB，×1e6
const WOKB_PRICE_NUM = Number((WOKB_PRICE_6 / 1_000_000n).toString() + "." + (WOKB_PRICE_6 % 1_000_000n).toString().padStart(6,"0"));

/* ============== 协议常量 ============== */
const TOPIC_SWAP_V2  = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/* ===================================== */

const pad32 = (addr) => "0x" + addr.replace(/^0x/,"").toLowerCase().padStart(64,"0");
const fromTopicAddr = (t) => "0x" + (t || "").slice(-40);
const hexToBig = (h) => (h ? BigInt(h) : 0n);
const short = (a) => a.slice(0,6) + "..." + a.slice(-4);

let ws, alive=false, backoff=1000, nextId=1;
let pingTimer=null;

// —— 订阅/请求映射 —— //
const reqTypeById = new Map();
const subTypeById = new Map();
const receiptReqTxById = new Map();
const resolvers = new Map();
const seenTx = new Set();

// 发送队列
let outbox = [];
const flushOutbox = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (outbox.length) {
    const payload = outbox.shift();
    try { ws.send(payload); } catch {}
  }
};

// token 元数据缓存
const tokenMeta = new Map();   // addrLower -> {symbol, decimals}
const pendingMeta = new Map(); // addrLower -> Promise

function now(){ return new Date().toISOString(); }
function send(obj){
  obj.id = ++nextId;
  const payload = JSON.stringify(obj);
  if (!ws || ws.readyState !== WebSocket.OPEN) outbox.push(payload);
  else { try { ws.send(payload); } catch { outbox.push(payload); } }
  return obj.id;
}

/* ===================== Telegram（仅环境变量） ===================== */
const TG_TOKEN     = (process.env.TG_BOT_TOKEN || "").trim();
const TG_CHAT_ID   = (process.env.TG_CHAT_ID || "").trim();
const EXPLORER_TX  = (process.env.EXPLORER_TX || "https://www.oklink.com/zh-hans/x-layer/tx/").trim();
const TG_ENABLED   = !!(TG_TOKEN && TG_CHAT_ID);
console.log(now(), TG_ENABLED ? "📣 Telegram 推送：已启用" : "📣 Telegram 推送：未启用（缺少 TG_BOT_TOKEN/TG_CHAT_ID）");

const fetchFn = (typeof fetch === "function")
  ? fetch
  : (...args) => import('node-fetch').then(({default: f}) => f(...args));

const tgQueue = [];
let tgBusy = false;
function tgEnq(fn){ tgQueue.push(fn); if (!tgBusy) tgPump(); }
async function tgPump(){
  tgBusy = true;
  while (tgQueue.length){
    const fn = tgQueue.shift();
    try { await fn(); } catch(e){ console.log(now(), "⚠️ TG 发送失败：", e?.message || e); }
    await new Promise(r=>setTimeout(r, 250));
  }
  tgBusy = false;
}
function splitChunks(s, max=3500){ const arr=[]; for(let i=0;i<s.length;i+=max) arr.push(s.slice(i,i+max)); return arr; }
function sendTgTrade(html, txHash){
  if (!TG_ENABLED) return;
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const chunks = splitChunks(String(html));
  chunks.forEach((chunk, idx) => {
    tgEnq(async () => {
      const body = {
        chat_id: TG_CHAT_ID,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      };
      if (idx === 0 && txHash) {
        body.reply_markup = {
          inline_keyboard: [[{ text: "🔗 在 OKLink 查看交易", url: EXPLORER_TX + txHash }]]
        };
      }
      await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(body)
      });
    });
  });
}
function fmtAmt(n, max=6) { const x = Number(n); return isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: max }) : String(n); }
function fmtUSD(n)       { const x = Number(n); return isFinite(x) ? ("$" + x.toLocaleString("en-US", { maximumFractionDigits: 2 })) : ""; }
function toNumDec(s)     { const x = Number(s); return isFinite(x) ? x : 0; }

/* ===================== wallets.json 读取 & 热更新 ===================== */
let WALLETS = [];                 // 纯地址数组（小写）
let WALLET_TOPICS = [];
let WALLET_SET = new Set();
let WALLET_LABELS = new Map();    // address(lower) -> label(string)

/** 解析 wallets.json：返回 [{address,label}]，兼容对象数组/映射/纯数组/纯文本 */
function parseWalletsText(txt){
  txt = String(txt || "").trim();
  // 1) 先尝试 JSON
  try {
    const j = JSON.parse(txt);
    const list = [];
    if (Array.isArray(j)) {
      for (const item of j) {
        if (typeof item === "string") {
          const a = item.trim().toLowerCase();
          if (/^0x[0-9a-f]{40}$/.test(a)) list.push({ address: a, label: "" });
        } else if (item && typeof item === "object" && item.address) {
          const a = String(item.address).trim().toLowerCase();
          const label = String(item.label || "").trim();
          if (/^0x[0-9a-f]{40}$/.test(a)) list.push({ address: a, label });
        }
      }
      return dedup(list);
    }
    if (j && typeof j === "object") {
      // 支持 { "0x..": "label", ... }
      const list2 = [];
      for (const [addr, lab] of Object.entries(j)) {
        const a = String(addr).trim().toLowerCase();
        if (/^0x[0-9a-f]{40}$/.test(a)) list2.push({ address: a, label: String(lab||"").trim() });
      }
      return dedup(list2);
    }
  } catch {}
  // 2) 退化为以空白/逗号分隔的文本地址
  const out = (txt.split(/[\s,]+/) || [])
    .map(s => String(s||"").trim().toLowerCase())
    .filter(a => /^0x[0-9a-f]{40}$/.test(a))
    .map(address => ({ address, label: "" }));
  return dedup(out);

  function dedup(arr){
    const m = new Map();
    for (const it of arr) m.set(it.address, String(it.label||"").trim());
    return [...m.entries()].map(([address,label]) => ({ address, label }));
  }
}

function refreshWallets(){
  try{
    const txt = fs.readFileSync(WALLETS_FILE, "utf8");
    const listObj = parseWalletsText(txt);            // [{address,label}]
    const nextAddrs = listObj.map(x => x.address);
    const changed = JSON.stringify(nextAddrs) !== JSON.stringify(WALLETS)
                 || JSON.stringify(listObj.map(x=>x.label)) !== JSON.stringify(nextAddrs.map(a => WALLET_LABELS.get(a)||""));
    if (changed){
      WALLETS = nextAddrs;
      WALLET_TOPICS = WALLETS.map(pad32);
      WALLET_SET = new Set(WALLETS);
      WALLET_LABELS = new Map(listObj.map(x => [x.address, x.label]));
      console.log(now(), `🗂️ 地址列表已加载：${WALLETS.length} 个`,
        listObj.map(x => (x.label ? `${x.label}(${short(x.address)})` : short(x.address))).join(", "));
    }
    return changed;
  }catch(e){
    console.log(now(), "⚠️ 无法读取地址文件", WALLETS_FILE, e?.message || e);
    return false;
  }
}
function requestReconnect(reason="wallets changed"){
  console.log(now(), `🔄 检测到 ${reason}，准备重连以应用新订阅`);
  backoff = 1000;
  try { ws?.terminate(); } catch {}
}
let watchTimer=null;
function watchWalletFile(){
  try{
    fs.watch(WALLETS_FILE, { persistent:true }, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        if (refreshWallets()){
          requestReconnect("wallets.json 变更");
        }
      }, 300);
    });
    console.log(now(), "👀 已开始监听地址文件：", WALLETS_FILE);
  }catch(e){
    console.log(now(), "⚠️ 监听地址文件失败：", e?.message || e);
  }
}

/* ============================ 解码 & 工具 ============================ */
function decodeSwapData(dataHex = "0x") {
  const hex = dataHex.replace(/^0x/, "").padStart(64 * 4, "0");
  const words = hex.match(/.{1,64}/g) || [];
  const u = (i) => hexToBig("0x" + (words[i] || "0"));
  return { amount0In: u(0), amount1In: u(1), amount0Out: u(2), amount1Out: u(3) };
}
function decodeTransferValue(dataHex = "0x"){
  const hex = dataHex.replace(/^0x/, "").padStart(64, "0");
  return hexToBig("0x" + hex);
}
function rpcCall(method, params, typeTag){
  const id = send({ method, params });
  reqTypeById.set(id, typeTag);
  return id;
}
function callDecimals(token){
  const t = token.toLowerCase();
  return new Promise((resolve) => {
    const id = rpcCall("eth_call", [{ to: t, data: "0x313ce567" }, "latest"], `call_decimals:${t}`);
    resolvers.set(id, resolve);
  });
}
function callSymbol(token){
  const t = token.toLowerCase();
  return new Promise((resolve) => {
    const id = rpcCall("eth_call", [{ to: t, data: "0x95d89b41" }, "latest"], `call_symbol:${t}`);
    resolvers.set(id, resolve);
  });
}
function decodeSymbol(retHex){
  if (!retHex || retHex === "0x") return null;
  const hex = retHex.replace(/^0x/, "");
  try {
    const off = parseInt(hex.slice(0,64),16);
    if (off === 32) {
      const len = parseInt(hex.slice(64,128),16);
      const data = hex.slice(128, 128 + len*2);
      return Buffer.from(data, "hex").toString("utf8").replace(/[^\x20-\x7E]/g,"").trim() || null;
    }
  } catch {}
  try {
    const bytes = hex.slice(0,64);
    const buf = Buffer.from(bytes, "hex");
    return buf.toString("utf8").replace(/\u0000+$/,"").trim() || null;
  } catch {}
  return null;
}
function formatUnits(bi, decimals, maxFrac=6){
  decimals = Math.max(0, Math.min(36, Number(decimals||0)));
  const neg = bi < 0n;
  const x = neg ? -bi : bi;
  const s = x.toString().padStart(decimals + 1, "0");
  let intPart = s.slice(0, -decimals) || "0";
  let frac = decimals ? s.slice(-decimals) : "";
  if (maxFrac >= 0 && frac) {
    if (frac.length > maxFrac) {
      const cut = frac.slice(0, maxFrac);
      const next = Number(frac[maxFrac] || "0");
      let rounded = BigInt(cut);
      if (next >= 5) rounded += 1n;
      frac = rounded.toString().padStart(maxFrac, "0");
      if (frac.length > maxFrac) {
        intPart = (BigInt(intPart) + 1n).toString();
        frac = frac.slice(1);
      }
    }
    frac = frac.replace(/0+$/,"");
  }
  return (neg ? "-" : "") + (frac ? `${intPart}.${frac}` : intPart);
}
function absBI(x){ return x<0n ? -x : x; }
function decStrFromBI(bi, decimals = 6) {
  const neg = bi < 0n; const x = neg ? -bi : bi;
  const SCALE = 10n ** BigInt(decimals);
  const i = x / SCALE, f = x % SCALE;
  let fs = f.toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return (neg ? "-" : "") + (fs ? `${i}.${fs}` : `${i}`);
}
function bigDivToDec(num, den, outDecimals = 6) {
  if (den === 0n) return null;
  const SCALE = 10n ** BigInt(outDecimals);
  return decStrFromBI((num * SCALE) / den, outDecimals);
}
// OKB(WOKB raw) -> 美元字符串（用 1e6 精度价格）
function usdStrFromWokbRaw(wokbRaw) {
  if (wokbRaw === 0n) return "";
  const usdMicro = (WOKB_PRICE_6 * wokbRaw) / (10n ** 18n); // ×1e6
  return "$" + decStrFromBI(usdMicro, 6);
}

// 计算 USDT/Token 单价（字符串）
function usdtPerTokenByWokb(wokbRaw, tokenRaw, tokenDec, outDecimals = 6) {
  try {
    const w = BigInt(wokbRaw);
    const t = BigInt(tokenRaw);
    const dec = BigInt(Number(tokenDec)||0);
    if (t <= 0n) return null;
    // price(×1e6) * w * 10^dec / (t * 10^18 * 10^6)
    const numer = WOKB_PRICE_6 * w * (10n ** dec);
    const denom = t * (10n ** 18n) * (10n ** 6n);
    return bigDivToDec(numer, denom, Number(outDecimals)||6);
  } catch {
    return null;
  }
}

/* ========== token 元数据 ========== */
async function ensureTokenMeta(token){
  const t = token.toLowerCase();
  if (t === WOKB_ADDR) return { symbol: "WOKB", decimals: WOKB_DECIMALS };
  if (tokenMeta.has(t)) return tokenMeta.get(t);
  if (pendingMeta.has(t)) return pendingMeta.get(t);
  const p = (async () => {
    let [symHex, decHex] = await Promise.all([
      new Promise(res => { const id = rpcCall("eth_call", [{to:t, data:"0x95d89b41"}, "latest"], `call_symbol:${t}`); resolvers.set(id, res); }),
      new Promise(res => { const id = rpcCall("eth_call", [{to:t, data:"0x313ce567"}, "latest"], `call_decimals:${t}`); resolvers.set(id, res); }),
    ]);
    let symbol = decodeSymbol(symHex) || t.slice(0,6).toUpperCase();
    let decimals = 18;
    try { decimals = Number(BigInt(decHex)); } catch {}
    const meta = { symbol, decimals };
    tokenMeta.set(t, meta);
    pendingMeta.delete(t);
    return meta;
  })();
  pendingMeta.set(t, p);
  return p;
}

/* ================================ 主连接 ================================ */
function connect(){
  refreshWallets();

  console.log(
    now(), "🔌 连接", WSS,
    "监听地址", (WALLETS.length ? WALLETS.map(short).join(", ") : "(空)"),
    "(topics:", (WALLET_TOPICS.length ? WALLET_TOPICS.join(",") : "(无)"), ")"
  );
  ws = new WebSocket(WSS);

  ws.on("open", () => {
    console.log(now(), "✅ 已连接，发送订阅");
    alive = true; backoff = 1000;
    subTypeById.clear();

    flushOutbox();

    reqTypeById.set(send({ method:"eth_subscribe", params:["newHeads"] }), "heads");

    if (WALLET_TOPICS.length > 0) {
      reqTypeById.set(send({ method:"eth_subscribe", params:["logs", { topics:[TOPIC_TRANSFER, null, WALLET_TOPICS] }] }), "tr_in");
      reqTypeById.set(send({ method:"eth_subscribe", params:["logs", { topics:[TOPIC_TRANSFER, WALLET_TOPICS, null] }] }), "tr_out");
      reqTypeById.set(send({ method:"eth_subscribe", params:["logs", { topics:[TOPIC_SWAP_V2, WALLET_TOPICS, null] }] }), "swap_sender");
      reqTypeById.set(send({ method:"eth_subscribe", params:["logs", { topics:[TOPIC_SWAP_V2, null, WALLET_TOPICS] }] }), "swap_to");
    } else {
      console.log(now(), "ℹ️ 地址列表为空，未订阅 Transfer/Swap。");
    }

    setTimeout(flushOutbox, 50);
    setTimeout(flushOutbox, 200);

    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!alive) { console.log(now(), "⚠️ 心跳丢失，重连"); try{ws.terminate();}catch{}; return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, PING_MS);
  });

  ws.on("pong", () => { alive = true; });

  ws.on("message", async (buf) => {
    alive = true;
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.id !== undefined) {
      const t = reqTypeById.get(msg.id);

      const isSubType = ["heads","tr_in","tr_out","swap_to","swap_sender"].includes(t);
      if (typeof msg.result === "string" && isSubType) {
        subTypeById.set(msg.result, t);
        console.log(now(), `📬 订阅成功 ${t} subId =`, msg.result);
        return;
      }

      if (t === "rpc_receipt") {
        const tx = receiptReqTxById.get(msg.id);
        receiptReqTxById.delete(msg.id);
        if (!msg.result) return;

        const logs = msg.result.logs || [];

        // === wrap/unwrap 扫描（OKB 直换）===
        const router = (msg.result?.to || "").toLowerCase();
        let wokbWrapToRouter = 0n;      // ZERO -> router
        let wokbUnwrapFromRouter = 0n;  // router -> ZERO
        for (const l of logs) {
          if ((l.topics?.[0]||"").toLowerCase() !== TOPIC_TRANSFER) continue;
          if ((l.address||"").toLowerCase() !== WOKB_ADDR) continue;
          const from = fromTopicAddr(l.topics[1]);
          const to   = fromTopicAddr(l.topics[2]);
          const val  = decodeTransferValue(l.data);
          if (from === ZERO_ADDR && to === router)  wokbWrapToRouter      += val;
          if (from === router   && to === ZERO_ADDR) wokbUnwrapFromRouter += val;
        }

        // === 按钱包统计净变动 ===
        const perWalletDeltas = new Map();
        const ensureMap = (w) => perWalletDeltas.get(w) || perWalletDeltas.set(w, new Map()).get(w);
        const transfers = logs.filter(l => (l.topics?.[0]||"").toLowerCase() === TOPIC_TRANSFER);
        for (const l of transfers) {
          const token = (l.address || "").toLowerCase();
          const from  = fromTopicAddr(l.topics[1]);
          const to    = fromTopicAddr(l.topics[2]);
          const value = decodeTransferValue(l.data);
          if (WALLET_SET.has(from)) { const m = ensureMap(from); m.set(token, (m.get(token) || 0n) - value); }
          if (WALLET_SET.has(to))   { const m = ensureMap(to);   m.set(token, (m.get(token) || 0n) + value); }
        }

        for (const [WALLET, deltas] of perWalletDeltas.entries()) {
          const items = [...deltas.entries()].filter(([,v]) => v !== 0n)
            .sort((a,b) => { const av = absBI(a[1]), bv = absBI(b[1]); return bv > av ? -1 : bv < av ? 1 : 0; });

          if (items.length === 0) continue;

          const label = WALLET_LABELS.get(WALLET) || "";
          console.log(`\n👛 Wallet ${label ? `${label} (${short(WALLET)})` : short(WALLET)}:`);

          const bn = parseInt(msg.result.blockNumber || "0x0", 16);

          if (items.length >= 2) {
            const [posToken, posValRaw] = items.find(([,v]) => v > 0n) || items[0];
            const [negToken, negValRaw] = items.find(([,v]) => v < 0n) || items[1];

            const [posMeta, negMeta] = await Promise.all([ensureTokenMeta(posToken), ensureTokenMeta(negToken)]);
            const posAmtStr = formatUnits(posValRaw, posMeta.decimals, 6);
            const negAmtStr = formatUnits(-negValRaw, negMeta.decimals, 6);

            let priceLine = "";
            let usdtPriceStr = null;

            if (posMeta.symbol === "WOKB" && -negValRaw > 0n) {
              usdtPriceStr = usdtPerTokenByWokb(posValRaw, -negValRaw, negMeta.decimals, 6);
              if (usdtPriceStr) priceLine = `@ ${usdtPriceStr} USDT/${negMeta.symbol}`;
            } else if (negMeta.symbol === "WOKB" && posValRaw > 0n) {
              usdtPriceStr = usdtPerTokenByWokb(-negValRaw, posValRaw, posMeta.decimals, 6);
              if (usdtPriceStr) priceLine = `@ ${usdtPriceStr} USDT/${posMeta.symbol}`;
            }

            if (!usdtPriceStr) {
              if (posValRaw > 0n && wokbWrapToRouter > 0n) {
                usdtPriceStr = usdtPerTokenByWokb(wokbWrapToRouter, posValRaw, posMeta.decimals, 6);
                if (usdtPriceStr) priceLine = `@ ${usdtPriceStr} USDT/${posMeta.symbol} (via wrap)`;
              } else if (-negValRaw > 0n && wokbUnwrapFromRouter > 0n) {
                usdtPriceStr = usdtPerTokenByWokb(wokbUnwrapFromRouter, -negValRaw, negMeta.decimals, 6);
                if (usdtPriceStr) priceLine = `@ ${usdtPriceStr} USDT/${negMeta.symbol} (via unwrap)`;
              }
            }

            // ===== Telegram =====
            const posAmtNum = toNumDec(formatUnits(posValRaw, posMeta.decimals, 6));
            const negAmtNum = toNumDec(formatUnits(-negValRaw, negMeta.decimals, 6));
            let wokbAmt = 0;
            if (posMeta.symbol === "WOKB") wokbAmt = toNumDec(formatUnits(posValRaw, 18, 6));
            if (negMeta.symbol === "WOKB") wokbAmt = toNumDec(formatUnits(-negValRaw, 18, 6));
            if (!wokbAmt) {
              if (wokbWrapToRouter > 0n)  wokbAmt = toNumDec(formatUnits(wokbWrapToRouter, 18, 6));
              if (wokbUnwrapFromRouter > 0n) wokbAmt = toNumDec(formatUnits(wokbUnwrapFromRouter, 18, 6));
            }
            const unitPrice = usdtPriceStr ? Number(usdtPriceStr) : null;
            let posUSD = null, negUSD = null;
            if (unitPrice && posMeta.symbol !== "WOKB") posUSD = posAmtNum * unitPrice;
            if (unitPrice && negMeta.symbol !== "WOKB") negUSD = negAmtNum * unitPrice;
            if (posUSD === null && posMeta.symbol === "WOKB") posUSD = wokbAmt * WOKB_PRICE_NUM;
            if (negUSD === null && negMeta.symbol === "WOKB") negUSD = wokbAmt * WOKB_PRICE_NUM;

            let action = "SWAP", focus = `${posMeta.symbol}/${negMeta.symbol}`;
            if (posMeta.symbol !== "WOKB" && negMeta.symbol === "WOKB") { action = "BUY";  focus = posMeta.symbol; }
            else if (posMeta.symbol === "WOKB" && negMeta.symbol !== "WOKB") { action = "SELL"; focus = negMeta.symbol; }
            else if (priceLine.includes("wrap"))   { action = "BUY";  focus = posMeta.symbol; }
            else if (priceLine.includes("unwrap")) { action = "SELL"; focus = negMeta.symbol; }

            // 非 WOKB 代币的合约地址（仅在一边是 WOKB 时展示）
            let tokenAddrForFooter = null;
            if (posToken.toLowerCase() === WOKB_ADDR) tokenAddrForFooter = negToken.toLowerCase();
            else if (negToken.toLowerCase() === WOKB_ADDR) tokenAddrForFooter = posToken.toLowerCase();

            const html = [
              `🔵 <b>${action} ${focus}</b> on XLayer`,
              label
                ? `👛 <b>${label}</b> (<code>${short(WALLET)}</code>)`
                : `👛 <code>${short(WALLET)}</code>`,
              `block <b>${bn}</b>`,
              `tx <code>${tx}</code>`,
              `💠 swapped <b>${fmtAmt(negAmtNum)}</b> ${negMeta.symbol} ↔ <b>${fmtAmt(posAmtNum)}</b> ${posMeta.symbol}` +
                (unitPrice ? ` (@ <b>$${fmtAmt(unitPrice,6)}</b>)` : ""),
              `<b>净变动：</b>`,
              `🟢 +${posAmtStr} ${posMeta.symbol}` + (posUSD!=null ? `  (${fmtUSD(posUSD)})` : ""),
              `🔴 -${negAmtStr} ${negMeta.symbol}` + (negUSD!=null ? `  (${fmtUSD(negUSD)})` : ""),
              tokenAddrForFooter ? `合约：<code>${tokenAddrForFooter}</code>` : ""
            ].filter(Boolean).join("\n");
            sendTgTrade(html, tx);

          } else {
            const [tk, vRaw] = items[0];
            const meta = await ensureTokenMeta(tk);

            let okbDeltaRaw = 0n;
            if (vRaw > 0n && wokbWrapToRouter > 0n) okbDeltaRaw = -wokbWrapToRouter;
            else if (vRaw < 0n && wokbUnwrapFromRouter > 0n) okbDeltaRaw = wokbUnwrapFromRouter;

            const tokenAmtStr = formatUnits(vRaw > 0n ? vRaw : -vRaw, meta.decimals, 6);
            const okbAmtStr   = okbDeltaRaw !== 0n ? formatUnits(okbDeltaRaw > 0n ? okbDeltaRaw : -okbDeltaRaw, 18, 6) : null;

            let priceLine = "";
            let usdtPriceStr = null;
            if (vRaw > 0n && wokbWrapToRouter > 0n) {
              usdtPriceStr = usdtPerTokenByWokb(wokbWrapToRouter, vRaw, meta.decimals, 6);
              if (usdtPriceStr) priceLine = `@ ${usdtPriceStr} USDT/${meta.symbol} (via wrap)`;
            } else if (vRaw < 0n && wokbUnwrapFromRouter > 0n) {
              usdtPriceStr = usdtPerTokenByWokb(wokbUnwrapFromRouter, -vRaw, meta.decimals, 6);
              if (usdtPriceStr) priceLine = `@ ${usdtPriceStr} USDT/${meta.symbol} (via unwrap)`;
            }

            const left = `${vRaw>0n?"+":"-"}${tokenAmtStr} ${meta.symbol}`;
            const right = okbAmtStr ? `   ${okbDeltaRaw>0n?"+":"-"}${okbAmtStr} OKB` : "";

            console.log(`   📊 你的净变动：\n      ${left}${right}${priceLine ? `\n      ${priceLine}` : ""}`);

            const tokenAmtNum = toNumDec(formatUnits(vRaw>0n? vRaw : -vRaw, meta.decimals, 6));
            const okbAmtNum   = okbDeltaRaw !== 0n ? toNumDec(formatUnits(okbDeltaRaw>0n? okbDeltaRaw : -okbDeltaRaw, 18, 6)) : 0;
            const unitPrice   = usdtPriceStr ? Number(usdtPriceStr) : null;
            const tokenUSD    = unitPrice ? tokenAmtNum * unitPrice : null;
            const okbUSD      = okbAmtNum ? okbAmtNum * WOKB_PRICE_NUM : null;
            const action      = (vRaw>0n) ? "BUY" : "SELL";

            const showContractAddr = (meta.symbol !== "WOKB") && (wokbWrapToRouter > 0n || wokbUnwrapFromRouter > 0n);

            const html = [
              `🔵 <b>${action} ${meta.symbol}</b> on XLayer`,
              label
                ? `👛 <b>${label}</b> (<code>${short(WALLET)}</code>)`
                : `👛 <code>${short(WALLET)}</code>`,
              `block <b>${bn}</b>`,
              `tx <code>${tx}</code>`,
              `💠 ${vRaw>0n? "received" : "sent"} <b>${fmtAmt(tokenAmtNum)}</b> ${meta.symbol}` +
                (okbAmtStr ? ` for <b>${fmtAmt(okbAmtNum)}</b> OKB` : "") +
                (unitPrice ? ` (@ <b>$${fmtAmt(unitPrice,6)}</b>)` : ""),
              `<b>净变动：</b>`,
              `${vRaw>0n?"🟢":"🔴"} ${left}` + (tokenUSD!=null ? `  (${fmtUSD(tokenUSD)})` : ""),
              okbAmtStr ? `${okbDeltaRaw>0n?"🟢":"🔴"} ${okbAmtStr} OKB` + (okbUSD!=null ? `  (${fmtUSD(okbUSD)})` : "") : "",
              showContractAddr ? `合约：<code>${tk.toLowerCase()}</code>` : ""
            ].filter(Boolean).join("\n");

            sendTgTrade(html, tx);
          }
        }

        return;
      }

      // —— 处理 ERC20 元数据 eth_call —— //
      if (typeof msg.result === "string" && String(t).startsWith("call_")) {
        const resolve = resolvers.get(msg.id);
        if (resolve) { resolvers.delete(msg.id); resolve(msg.result); }
        return;
      }
    }

    // === 推送（订阅数据）===
    if (msg.method === "eth_subscription" && msg.params) {
      const { subscription, result } = msg.params;
      const t = subTypeById.get(subscription);
      if (!t) return;

      if (t === "heads" && result?.number) {
        const bn = parseInt(result.number, 16);
        return process.stdout.write(`WS ⛓️  block=${bn}                                   \r`);
      }

      if ((t === "tr_in" || t === "tr_out") && result?.topics?.length >= 3) {
        const token   = result.address;
        const bn      = parseInt(result.blockNumber, 16);
        const tx      = result.transactionHash;
        const from    = fromTopicAddr(result.topics[1]);
        const to      = fromTopicAddr(result.topics[2]);
        const value   = decodeTransferValue(result.data);

        console.log(
          `\n💸 Transfer ${t === "tr_in" ? "➡️ 收到" : "⬅️ 转出"}  token=${token}\n` +
          `   block=${bn} tx=${tx}\n` +
          `   from=${from} → to=${to}\n` +
          `   value=${value.toString()}  removed=${result.removed === true}`
        );
        if (result.removed !== true && !seenTx.has(tx)) {
          seenTx.add(tx);
          const id = send({ method: "eth_getTransactionReceipt", params: [tx] });
          reqTypeById.set(id, "rpc_receipt");
          receiptReqTxById.set(id, tx);
        }
        return;
      }

      if (result?.topics && result.topics[0]?.toLowerCase() === TOPIC_SWAP_V2) {
        const pool   = result.address;
        const bn     = parseInt(result.blockNumber, 16);
        const tx     = result.transactionHash;
        const topics = result.topics;
        const sender = fromTopicAddr(topics[1]);
        const to     = fromTopicAddr(topics[2]);
        const { amount0In, amount1In, amount0Out, amount1Out } = decodeSwapData(result.data);

        console.log(
          `\n🌀 Swap V2  (${t})  pool=${pool}\n` +
          `   block=${bn} tx=${tx}\n` +
          `   sender=${sender} → to=${to}\n` +
          `   amount0In=${amount0In}  amount1In=${amount1In}\n` +
          `   amount0Out=${amount0Out}  amount1Out=${amount1Out}\n` +
          `   removed=${result.removed === true}`
        );
      }
    }
  });

  function relaunch(reason){
    try{ ws.terminate(); }catch{}
    clearInterval(pingTimer);
    outbox = [];
    const wait = Math.min(backoff, MAX_BACKOFF) * (0.85 + Math.random()*0.3);
    console.log(now(), `🔁 ${reason}，${Math.round(wait)}ms 后重连`);
    setTimeout(connect, wait);
    backoff *= 2;
  }

  ws.on("error", (e)  => relaunch("error: " + (e?.message || e)));
  ws.on("close", (c)  => relaunch("close: " + c));
}

/* ================================ 启动 ================================ */
refreshWallets();
watchWalletFile();
connect();
