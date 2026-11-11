/* 自动备份：每日 03:00 用 SQLite 的 VACUUM INTO 生成完整备份（免停服）
 * 备份目录 data/backups/，保留最近 14 份自动滚动删除
 * VACUUM INTO 是 SQLite 官方推荐的在线备份方式：写入的是一个紧凑的、
 * 事务一致的数据库副本，不需要停服务，也不需要复制 -wal 文件
 */
const fs = require("fs");
const path = require("path");

function ymd(d) {
  const x = d || new Date();
  return x.getFullYear() + String(x.getMonth() + 1).padStart(2, "0") + String(x.getDate()).padStart(2, "0");
}

function backupsDir(dataDir) { return path.join(dataDir, "backups"); }

function listBackups(dataDir) {
  const dir = backupsDir(dataDir);
  try {
    return fs.readdirSync(dir)
      .filter(f => /^hwbench-\d{8}\.db$/.test(f))
      .sort()
      .reverse();
  } catch (e) { return []; }
}

function createBackup(dataDir, { keep = 14 } = {}) {
  const dir = backupsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `hwbench-${ymd()}.db`;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) {
    prune(dataDir, keep);   // 当天已备份：仍执行滚动清理
    return { ok: true, file: name, skipped: true };
  }
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "hwbench.db"));
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    db.close();
    prune(dataDir, keep);
    return { ok: true, file: name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function prune(dataDir, keep) {
  const all = listBackups(dataDir);
  all.slice(keep).forEach(f => { try { fs.unlinkSync(path.join(backupsDir(dataDir), f)); } catch (e) {} });
}

/* 计算距离下一个 03:00 的毫秒数（用 shell 时间，不要硬编码） */
function msToNext3am() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/* 每日循环调度：到点备份，然后排下一天 */
function scheduleDaily(dataDir, logger) {
  const run = async () => {
    const r = createBackup(dataDir);
    if (logger) logger(r);
  };
  const loop = () => {
    setTimeout(() => { run().then(loop).catch(loop); }, msToNext3am()).unref();
  };
  loop();
  /* 进程启动时若今天还没有备份，先补一份（防止服务白天才启动错过 03:00） */
  const today = `hwbench-${ymd()}.db`;
  if (!listBackups(dataDir).includes(today)) run();
}

module.exports = { createBackup, scheduleDaily, listBackups, msToNext3am };
