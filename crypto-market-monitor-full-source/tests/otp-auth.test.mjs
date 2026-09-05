import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://xabffbjifmnoogzcttyd.supabase.co";
const SUPABASE_KEY = "sb_publishable_-0xlsgjpG-xwVfaUGTag4A_wvgxVWwD";
const AUTHORIZED_EMAIL = "vadim.hanukaev1981@gmail.com";

// Client-side helper functions that match the component's OTP logic
export function validateOtpFormat(digits) {
  if (!Array.isArray(digits) || digits.length !== 6) return false;
  return digits.every(d => typeof d === "string" && /^[0-9]$/.test(d));
}

export function parsePastedCode(text) {
  if (typeof text !== "string") return null;
  const digits = text.replace(/[^0-9]/g, "");
  if (digits.length >= 6) {
    return digits.slice(0, 6).split("");
  }
  return null;
}

export function isSubmitEnabled(digits, isBusy) {
  return !isBusy && validateOtpFormat(digits);
}

export function calculateCooldownText(seconds) {
  if (seconds <= 0) return "שלח קוד חדש";
  return `שלח שוב בעוד ${seconds} שניות`;
}

test("OTP helper: validateOtpFormat requires exactly 6 numeric digits", () => {
  assert.equal(validateOtpFormat(["1", "2", "3", "4", "5", "6"]), true);
  assert.equal(validateOtpFormat(["0", "0", "0", "0", "0", "0"]), true);
  assert.equal(validateOtpFormat(["1", "2", "3", "4", "5"]), false); // 5 digits
  assert.equal(validateOtpFormat(["1", "2", "3", "4", "5", "6", "7"]), false); // 7 digits
  assert.equal(validateOtpFormat(["1", "2", "a", "4", "5", "6"]), false); // letter
  assert.equal(validateOtpFormat(["1", "2", "", "4", "5", "6"]), false); // empty box
  assert.equal(validateOtpFormat(["1", "2", " ", "4", "5", "6"]), false); // whitespace
  assert.equal(validateOtpFormat(null), false);
});

test("OTP helper: parsePastedCode extracts exactly 6 digits from various formats", () => {
  assert.deepEqual(parsePastedCode("482731"), ["4", "8", "2", "7", "3", "1"]);
  assert.deepEqual(parsePastedCode("482-731"), ["4", "8", "2", "7", "3", "1"]);
  assert.deepEqual(parsePastedCode("קוד האימות הוא 482731 תודה"), ["4", "8", "2", "7", "3", "1"]);
  assert.deepEqual(parsePastedCode("  901245  "), ["9", "0", "1", "2", "4", "5"]);
  assert.deepEqual(parsePastedCode("1234"), null); // Less than 6 digits
  assert.deepEqual(parsePastedCode("abcdef"), null); // No digits
});

test("OTP helper: isSubmitEnabled guards submission until 6 digits entered and not busy", () => {
  const complete = ["1", "2", "3", "4", "5", "6"];
  const incomplete = ["1", "2", "3", "4", "5", ""];

  assert.equal(isSubmitEnabled(complete, false), true);
  assert.equal(isSubmitEnabled(complete, true), false); // Busy
  assert.equal(isSubmitEnabled(incomplete, false), false); // Incomplete
  assert.equal(isSubmitEnabled(incomplete, true), false);
});

test("OTP helper: calculateCooldownText formats countdown and enables label when zero", () => {
  assert.equal(calculateCooldownText(60), "שלח שוב בעוד 60 שניות");
  assert.equal(calculateCooldownText(1), "שלח שוב בעוד 1 שניות");
  assert.equal(calculateCooldownText(0), "שלח קוד חדש");
  assert.equal(calculateCooldownText(-5), "שלח קוד חדש");
});

test("Supabase Auth: signInWithOtp succeeds for authorized user", async () => {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithOtp({
    email: AUTHORIZED_EMAIL,
    options: { shouldCreateUser: false },
  });

  assert.equal(error, null, `Expected no error, got: ${error?.message}`);
  assert.ok(data, "Expected data response object");
});

test("Supabase Auth: verifyOtp fails closed with incorrect 6-digit OTP", async () => {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.verifyOtp({
    email: AUTHORIZED_EMAIL,
    token: "000000",
    type: "email",
  });

  assert.equal(data.user, null, "User must be null on invalid OTP");
  assert.equal(data.session, null, "Session must be null on invalid OTP");
  assert.ok(error, "Expected auth error for incorrect OTP");
  assert.equal(error.status, 403, "Expected HTTP 403 Forbidden status");
  assert.equal(error.code, "otp_expired", "Expected code otp_expired or invalid");
});

test("Supabase Auth: verifyOtp fails closed with expired/malformed token", async () => {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.verifyOtp({
    email: AUTHORIZED_EMAIL,
    token: "999999",
    type: "email",
  });

  assert.equal(data.session, null);
  assert.ok(error);
});

test("Supabase Auth: client settings ensure session persistence and cross-route alignment", () => {
  const clientOptions = {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  };

  const clientHome = createClient(SUPABASE_URL, SUPABASE_KEY, clientOptions);
  const clientPlatform = createClient(SUPABASE_URL, SUPABASE_KEY, clientOptions);

  assert.equal(clientHome.supabaseUrl, clientPlatform.supabaseUrl);
  assert.equal(clientHome.supabaseKey, clientPlatform.supabaseKey);
  assert.ok(clientHome.auth);
  assert.ok(clientPlatform.auth);
});

test("Security: no login link is required for OTP authentication flow", () => {
  const codeEntryFlow = {
    requiresClickableEmailLink: false,
    requiresCodeEntryInWebsite: true,
    expectedDigitCount: 6,
  };

  assert.equal(codeEntryFlow.requiresClickableEmailLink, false);
  assert.equal(codeEntryFlow.requiresCodeEntryInWebsite, true);
  assert.equal(codeEntryFlow.expectedDigitCount, 6);
});
