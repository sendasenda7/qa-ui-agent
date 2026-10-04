import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeTargetUrl, isPrivateIp } from "../src/url-guard.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const rebindLookup = async () => [{ address: "127.0.0.1", family: 4 }];

async function rejects(url, deps = {}) {
  await assert.rejects(() => assertSafeTargetUrl(url, { lookup: publicLookup, env: {}, ...deps }), {
    name: "HttpError",
    status: 400,
  });
}

test("refuse les schémas autres que http(s)", async () => {
  await rejects("file:///etc/passwd");
  await rejects("chrome://settings");
  await rejects("javascript:alert(1)");
  await rejects("pas une url");
});

test("refuse localhost, les IP privées, link-local (métadonnées cloud) et IPv6 locales", async () => {
  for (const url of [
    "http://localhost:3000",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://192.168.1.10/",
    "http://172.16.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::127.0.0.1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://monserveur.internal/",
  ]) {
    await rejects(url);
  }
});

test("refuse un domaine public qui pointe vers une IP locale (DNS rebinding)", async () => {
  await rejects("https://evil.example.com/", { lookup: rebindLookup });
});

test("accepte une URL publique", async () => {
  const url = "https://staging.helpify.tn/auth/login";
  assert.equal(await assertSafeTargetUrl(url, { lookup: publicLookup, env: {} }), url);
});

test("ALLOW_PRIVATE_TARGETS=true autorise localhost (dev)", async () => {
  const url = "http://localhost:4200/";
  assert.equal(await assertSafeTargetUrl(url, { env: { ALLOW_PRIVATE_TARGETS: "true" } }), url);
});

test("ALLOWED_TARGET_HOSTS limite aux hôtes listés (jokers *. compris)", async () => {
  const env = { ALLOWED_TARGET_HOSTS: "staging.helpify.tn, *.devwise.tn" };
  const deps = { lookup: publicLookup, env };
  await assertSafeTargetUrl("https://staging.helpify.tn/", deps);
  await assertSafeTargetUrl("https://app.devwise.tn/", deps);
  await rejects("https://autre-site.com/", deps);
});

test("isPrivateIp : cas limites", () => {
  assert.equal(isPrivateIp("172.15.0.1"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
  assert.equal(isPrivateIp("172.31.255.255"), true);
});
