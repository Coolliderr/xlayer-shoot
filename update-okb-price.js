// update-okb-price.js
// 每小时从 OKX 拉 OKB/USDT 最新价，若有变更：写回 .env 并 pm2 重启主进程
// 运行：pm2 start update-okb-price.js --name okb-price-updater

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ENV_FILE   = path.join(__dirname, ".env");
const API        = "https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT";
const INTERVAL_MS = 10 * 60 * 1000; // 10 分钟更新一次
const PM2_PROC   = "xlayer-trade-listener"; // 主脚本进程名
const PM2_BIN    = "pm2"; // pm2 可执行文件

const fetchFn = (typeof fetch === "function")
  ? fetch
  : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

async function fetchOkbPrice() {
  const r = await fetchFn(API, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const last = Number(j?.data?.[0]?.last);
  if (!Number.isFinite(last)) throw new Error("Invalid price payload");
  return last; // 如 42.1375
}

function setEnvVar(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  return (text.replace(/\s*$/, "") + "\n" + line + "\n");
}

function getEnvVar(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, "m"));
  return m ? m[1].trim() : null;
}

async function writeFileAtomic(file, content) {
  const tmp = file + ".tmp";
  await fs.promises.writeFile(tmp, content);
  await fs.promises.rename(tmp, file);
}

function pm2Restart(name) {
  return new Promise((resolve) => {
    const child = spawn(PM2_BIN, ["restart", name], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function updateOnce() {
  const price = await fetchOkbPrice();
  const value = price.toFixed(1); // 只保留 1 位小数（减少无意义重启）

  let env = "";
  try { env = await fs.promises.readFile(ENV_FILE, "utf8"); } catch {}
  const prev = getEnvVar(env, "WOKB_PRICE");

  if (prev === value) {
    console.log(new Date().toISOString(), `价格未变化（仍为 ${value}），跳过写入/重启`);
    return;
  }

  const next = setEnvVar(env, "WOKB_PRICE", value);
  await writeFileAtomic(ENV_FILE, next);
  console.log(new Date().toISOString(), `WOKB_PRICE=${value} 已写入 ${ENV_FILE}（前值：${prev ?? "无"}）`);

  const ok = await pm2Restart(PM2_PROC);
  console.log(new Date().toISOString(), ok
    ? `已重启 pm2 进程：${PM2_PROC}`
    : `⚠️ 重启 pm2 进程失败：${PM2_PROC}`);
}

(async function main() {
  try { await updateOnce(); } catch (e) { console.error("首次更新失败:", e?.message || e); }
  setInterval(() => {
    updateOnce().catch(e => console.error("定时更新失败:", e?.message || e));
  }, INTERVAL_MS);
})();
