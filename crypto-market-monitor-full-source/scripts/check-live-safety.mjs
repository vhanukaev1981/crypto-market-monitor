import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".next", "dist", ".wrangler", "coverage"]);
const EXCLUDED_FILES = new Set([
  path.normalize("scripts/check-live-safety.mjs"),
  path.normalize("docs/LIVE_TRADING_READINESS_HE.md"),
]);
const EXECUTABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sql", ".sh"]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile() && EXECUTABLE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.normalize(path.relative(ROOT, file));
}

function addFinding(findings, severity, file, message) {
  findings.push({ severity, file: relative(file), message });
}

const findings = [];
const files = (await walk(ROOT)).filter((file) => !EXCLUDED_FILES.has(relative(file)));

for (const file of files) {
  const text = await readFile(file, "utf8");

  if (/\/v5\/asset\/withdraw\/create/i.test(text)) {
    addFinding(findings, "critical", file, "נמצא נתיב API לביצוע משיכה מ-Bybit");
  }

  if (/withdrawals?_enabled\s*[:=]\s*true\b/i.test(text)) {
    addFinding(findings, "critical", file, "נמצאה הפעלה מפורשת של משיכות");
  }

  if (/https:\/\/api\.bybit\.com[^"'`\s]*\/v5\/order\/create|\/v5\/order\/create[^"'`\s]*https:\/\/api\.bybit\.com/i.test(text)) {
    addFinding(findings, "critical", file, "נמצאה יצירת פקודה מול כתובת Mainnet");
  }

  if (/\/v5\/order\/create/i.test(text) && !/https:\/\/api-demo\.bybit\.com/i.test(text)) {
    addFinding(findings, "critical", file, "קוד שיוצר פקודות אינו נעול במפורש ל-Bybit Demo");
  }

  if (/(?:API_SECRET|SECRET_KEY|CRON_TOKEN)\s*=\s*["'][^"'\n]{12,}["']/i.test(text)) {
    addFinding(findings, "critical", file, "נמצא סוד גישה שנראה כתוב ישירות בקוד");
  }

  if (/shouldCreateUser\s*:\s*true/i.test(text)) {
    addFinding(findings, "warning", file, "כניסת OTP עדיין מאפשרת יצירת משתמש חדש; במערכת אישית מומלץ לבטל");
  }

  if (/environment\s*:\s*["']live["']/i.test(text) && /enabled\s*:\s*true/i.test(text)) {
    addFinding(findings, "critical", file, "נמצאה תצורת Live פעילה בקוד");
  }
}

const critical = findings.filter((item) => item.severity === "critical");
const warnings = findings.filter((item) => item.severity === "warning");

for (const item of findings) {
  const prefix = item.severity === "critical" ? "❌" : "⚠️";
  console.log(`${prefix} ${item.file}: ${item.message}`);
}

console.log(`\nנסרקו ${files.length} קבצים. כשלים קריטיים: ${critical.length}. אזהרות: ${warnings.length}.`);

if (critical.length > 0) process.exit(1);
