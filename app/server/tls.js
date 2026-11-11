/* 自签名证书：让平板通过局域网 https 访问（麦克风与 PWA 要求安全上下文）
 * 用系统 openssl 生成，证书 SAN 覆盖 localhost + 全部局域网 IPv4
 * 有效期 825 天，剩余不足 300 天或网卡 IP 变化时自动重签
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

function lanIPs() {
  const out = [];
  const n = os.networkInterfaces();
  for (const k in n) for (const i of n[k] || []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  return [...new Set(out)];
}

/* 虚拟网卡（VMware / VirtualBox / Tailscale / ZeroTier / 蒲公英等）不作为主推荐地址，
 * 但仍会写进证书 SAN，保证哪种网络下都能打开 */
const VIRTUAL = /vmware|virtualbox|vethernet|tailscale|zerotier|oray|loopback|npcap|hyper-v|tun|tap|docker|wsl/i;

function displayIPs() {
  const n = os.networkInterfaces();
  const physical = [], virtual = [];
  for (const k in n) {
    if (!/^(以太网|WLAN|Wi-?Fi|Ethernet|eth|en|wlan)/i.test(k)) continue;
    for (const i of n[k] || []) if (i.family === "IPv4" && !i.internal) {
      (VIRTUAL.test(k) ? virtual : physical).push(i.address);
    }
  }
  const all = [...new Set(physical)];
  if (all.length) return all;
  return [...new Set([...virtual, ...lanIPs()])];
}

const CN = "hwbench.local";

function ensureCert(dataDir, log = console.log) {
  const dir = path.join(dataDir, "certs");
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  const metaFile = path.join(dir, "meta.json");
  const ips = lanIPs();

  fs.mkdirSync(dir, { recursive: true });

  try {
    const m = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    const ageDays = (Date.now() - new Date(m.created_at).getTime()) / 86400000;
    const sameIPs = (m.ips || []).join(",") === ips.join(",");
    if (ageDays < 300 && sameIPs && fs.existsSync(keyFile) && fs.existsSync(certFile)) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), ips: m.ips, cached: true };
    }
  } catch (e) { /* 无证书或元数据损坏，重签 */ }

  /* 用配置文件而非 -subj，避免 Windows/Git Bash 的路径转换把 /C=CN 当成目录 */
  const alt = ips.map((ip, i) => `IP.${i + 2} = ${ip}`).join("\n");
  const cnf = [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = v3",
    "prompt = no",
    "[dn]",
    `CN = ${CN}`,
    "O = Home Workbench",
    "C = CN",
    "[v3]",
    "basicConstraints = critical,CA:TRUE",
    "keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign",
    "extendedKeyUsage = serverAuth",
    "subjectAltName = @alt",
    "[alt]",
    "DNS.1 = localhost",
    `DNS.2 = ${CN}`,
    "IP.1 = 127.0.0.1",
    alt
  ].join("\n");
  fs.writeFileSync(path.join(dir, "openssl.cnf"), cnf, "utf8");

  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "825", "-nodes",
      "-keyout", "key.pem", "-out", "cert.pem", "-config", "openssl.cnf"
    ], { cwd: dir, stdio: "pipe", timeout: 30000 });
  } catch (e) {
    log("[tls] 自签名证书生成失败（openssl 不可用）：" + (e.stderr ? e.stderr.toString().slice(0, 200) : e.message));
    return null;
  }

  const meta = { created_at: new Date().toISOString(), ips, cn: CN, days: 825 };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  log(`[tls] 已生成自签名证书，覆盖：localhost, ${ips.join(", ") || "无局域网 IP"}`);
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), ips, cached: false, dir };
}

module.exports = { ensureCert, lanIPs, displayIPs, CN };
