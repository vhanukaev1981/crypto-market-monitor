import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";


test("אין בקוד נתיב משיכה או יצירת פקודות Mainnet", () => {
  const result = spawnSync(process.execPath, ["scripts/check-live-safety.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `בדיקת בטיחות המסחר נכשלה.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
});
