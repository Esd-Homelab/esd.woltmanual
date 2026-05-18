const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { URL, URLSearchParams } = require("url");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const ACCOUNTS_PATH = path.join(ROOT_DIR, "accounts.json");
const HERO_BASE = "https://hero-sms.com/stubs/handler_api.php";
const TESTMAIL_BASE = "https://api.testmail.app/api/json";
const WOLT_SERVICE = "rr";
const PORT = Number(process.env.PORT || 5137);
const WOLT_URL = "https://wolt.com";

const COUNTRY_DIAL_CODES = {
  1: "380",
  2: "7",
  3: "86",
  4: "63",
  6: "62",
  7: "60",
  8: "254",
  10: "84",
  11: "996",
  13: "972",
  14: "852",
  15: "48",
  16: "44",
  19: "234",
  21: "20",
  22: "91",
  23: "353",
  24: "855",
  29: "381",
  31: "27",
  32: "40",
  33: "57",
  34: "372",
  36: "1",
  37: "212",
  39: "54",
  40: "998",
  43: "49",
  44: "370",
  46: "46",
  48: "31",
  49: "371",
  56: "34",
  63: "420",
  78: "33",
  86: "39",
  163: "358",
  172: "45",
  174: "47",
  187: "1"
};

const FALLBACK_COUNTRIES = [
  { id: 15, name: "Poland", dialCode: "48" },
  { id: 172, name: "Denmark", dialCode: "45" },
  { id: 46, name: "Sweden", dialCode: "46" },
  { id: 43, name: "Germany", dialCode: "49" },
  { id: 48, name: "Netherlands", dialCode: "31" },
  { id: 16, name: "United Kingdom", dialCode: "44" },
  { id: 78, name: "France", dialCode: "33" },
  { id: 187, name: "USA", dialCode: "1" }
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function cleanConfigJson(text) {
  return text.replace(/^\uFEFF/, "").replace(/,\s*([}\]])/g, "$1");
}

async function loadConfig() {
  const text = await fs.readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(cleanConfigJson(text));
  return {
    sms_api_key: String(parsed.sms_api_key || "").trim(),
    testmail_api_key: String(parsed.testmail_api_key || "").trim(),
    testmail_namespace: String(parsed.testmail_namespace || "").trim()
  };
}

function missingKeys(config, keys) {
  return keys.filter((key) => !config[key]);
}

function publicConfig(config) {
  const missing = missingKeys(config, [
    "sms_api_key",
    "testmail_api_key",
    "testmail_namespace"
  ]);
  return {
    success: true,
    testmail_namespace: config.testmail_namespace,
    has_sms_api_key: Boolean(config.sms_api_key),
    has_testmail_api_key: Boolean(config.testmail_api_key),
    missing
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return { response, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  return JSON.parse(body);
}

async function readAccounts() {
  try {
    const text = await fs.readFile(ACCOUNTS_PATH, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeAccounts(accounts) {
  const ordered = [...accounts].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  await fs.writeFile(ACCOUNTS_PATH, `${JSON.stringify({ accounts: ordered }, null, 2)}\n`, "utf8");
  return ordered;
}

async function upsertAccount(fields) {
  const email = String(fields.email || "").trim().toLowerCase();
  if (!email) throw new Error("Missing account email");

  const accounts = await readAccounts();
  const now = new Date().toISOString();
  const index = accounts.findIndex((account) => String(account.email || "").toLowerCase() === email);
  const existing = index >= 0 ? accounts[index] : {};
  const next = {
    ...existing,
    ...fields,
    email,
    created_at: existing.created_at || fields.created_at || now,
    updated_at: now
  };

  if (index >= 0) accounts[index] = next;
  else accounts.unshift(next);

  await writeAccounts(accounts);
  return next;
}

async function deleteAccount(email) {
  const target = String(email || "").trim().toLowerCase();
  if (!target) throw new Error("Missing account email");

  const accounts = await readAccounts();
  const next = accounts.filter((account) => String(account.email || "").toLowerCase() !== target);
  await writeAccounts(next);
  return accounts.length !== next.length;
}

async function heroRequest(params, timeoutMs = 15000) {
  const url = new URL(HERO_BASE);
  url.search = new URLSearchParams(params).toString();
  return fetchWithTimeout(url, {}, timeoutMs);
}

function heroError(result) {
  if (result.json && result.json.title) {
    return [result.json.title, result.json.details].filter(Boolean).join(": ");
  }

  const text = result.text.trim();
  if (
    text.startsWith("BAD_") ||
    text.startsWith("NO_") ||
    text.startsWith("WRONG_") ||
    text.startsWith("ERROR_") ||
    text.includes("UNPROCESSABLE_ENTITY")
  ) {
    return text;
  }

  return "";
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const match = String(value).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseBalance(result) {
  if (result.json) {
    const direct =
      result.json.balance ??
      result.json.BALANCE ??
      result.json.money ??
      result.json.amount ??
      result.json.data?.balance;
    const parsed = parseNumber(direct);
    if (parsed !== null) return parsed;
  }

  const text = result.text.trim();
  if (text.startsWith("ACCESS_BALANCE:")) {
    return parseNumber(text.split(":")[1]);
  }

  return parseNumber(text);
}

function readPriceObject(candidate) {
  if (!candidate || typeof candidate !== "object") return null;

  const price =
    parseNumber(candidate.cost) ??
    parseNumber(candidate.price) ??
    parseNumber(candidate.retailPrice) ??
    parseNumber(candidate.amount);

  const count =
    parseNumber(candidate.count) ??
    parseNumber(candidate.quantity) ??
    parseNumber(candidate.available);

  if (price === null && count === null) return null;
  return { price, count };
}

function parsePriceData(json, country, service) {
  if (!json || typeof json !== "object") return { price: null, count: null };

  const countryKey = String(country);
  const direct =
    json[countryKey]?.[service] ??
    json[service]?.[countryKey] ??
    json[service] ??
    json[countryKey] ??
    json.data?.[countryKey]?.[service] ??
    json.data?.[service]?.[countryKey];

  const directPrice = readPriceObject(direct);
  if (directPrice) return directPrice;

  const stack = [json];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;

    const currentService = String(current.service ?? current.serviceCode ?? "");
    const currentCountry = String(current.country ?? current.countryId ?? "");
    const matchesService = !currentService || currentService === service;
    const matchesCountry = !currentCountry || currentCountry === countryKey;
    const price = readPriceObject(current);

    if (price && matchesService && matchesCountry) return price;

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }

  return { price: null, count: null };
}

function stripHtml(input) {
  return String(input || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(input) {
  return String(input || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanUrl(input) {
  return decodeHtmlEntities(input)
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/[)\].,;]+$/g, "");
}

function isLoginMagicLink(link) {
  try {
    const url = new URL(link);
    return !url.searchParams.has("new_user");
  } catch {
    return !/[?&]new_user=/i.test(link);
  }
}

function extractMagicLink(email, options = {}) {
  const blocks = [email.html, email.text, email.headers].filter(Boolean).map(String);
  const kind = options.kind || "any";

  for (const block of blocks) {
    const decoded = decodeHtmlEntities(block);
    const hrefMatches = decoded.matchAll(/href=["']([^"']*wolt\.com\/me\/magic_login[^"']*)["']/gi);
    for (const match of hrefMatches) {
      const link = cleanUrl(match[1]);
      if (kind !== "login" || isLoginMagicLink(link)) return link;
    }

    const urlMatches = decoded.matchAll(/https?:\/\/(?:www\.)?wolt\.com\/me\/magic_login[^\s"'<>]+/gi);
    for (const match of urlMatches) {
      const link = cleanUrl(match[0]);
      if (kind !== "login" || isLoginMagicLink(link)) return link;
    }
  }

  return null;
}

function extractLinks(email) {
  const blocks = [email.html, email.text].filter(Boolean).map(String);
  const links = [];
  const seen = new Set();

  for (const block of blocks) {
    const decoded = decodeHtmlEntities(block);
    const hrefMatches = decoded.matchAll(/href=["']([^"']+)["']/gi);
    for (const match of hrefMatches) {
      const link = cleanUrl(match[1]);
      if (/^https?:\/\//i.test(link) && !seen.has(link)) {
        seen.add(link);
        links.push(link);
      }
    }

    const urlMatches = decoded.matchAll(/https?:\/\/[^\s"'<>]+/gi);
    for (const match of urlMatches) {
      const link = cleanUrl(match[0]);
      if (!seen.has(link)) {
        seen.add(link);
        links.push(link);
      }
    }
  }

  return links;
}

function emailRecipient(email) {
  const recipient = email.envelope_to || email.to || email.recipient || "";
  if (Array.isArray(recipient)) return recipient.join(", ");
  return String(recipient);
}

function recipientMatches(email, target) {
  const recipient = emailRecipient(email).toLowerCase();
  const parts = recipient.split(/[\s,;<>]+/).filter(Boolean);
  return recipient === target || parts.includes(target);
}

function normalizeEmail(email, index) {
  const text = stripHtml(email.text || email.html || "");
  return {
    id: email.id || email.messageId || `${email.date || email.timestamp || "mail"}-${index}`,
    from: String(email.from || ""),
    to: emailRecipient(email),
    subject: String(email.subject || "(no subject)"),
    date: email.date || email.timestamp || null,
    preview: text.slice(0, 220),
    has_magic_link: Boolean(extractMagicLink(email))
  };
}

function normalizeEmailDetail(email, index) {
  const textContent = String(email.text || "").trim();
  const htmlContent = String(email.html || "").trim();

  return {
    ...normalizeEmail(email, index),
    text: textContent || stripHtml(htmlContent),
    html_text: stripHtml(htmlContent),
    links: extractLinks(email),
    magic_link: extractMagicLink(email)
  };
}

async function fetchTestmailEmails(config, limit = 10, offset = 0) {
  const url = new URL(TESTMAIL_BASE);
  url.search = new URLSearchParams({
    apikey: config.testmail_api_key,
    namespace: config.testmail_namespace,
    pretty: "true",
    limit: String(limit),
    offset: String(offset)
  }).toString();

  const result = await fetchWithTimeout(url, {}, 15000);
  if (!result.response.ok) {
    throw new Error(`Testmail API returned ${result.response.status}: ${result.text.slice(0, 500)}`);
  }

  return result.json || {};
}

function sortedEmails(data) {
  return Array.isArray(data.emails)
    ? [...data.emails].sort((a, b) => Number(b.date || b.timestamp || 0) - Number(a.date || a.timestamp || 0))
    : [];
}

function stripCountryCode(phoneNumber, countryId) {
  const digits = String(phoneNumber || "").replace(/[^\d+]/g, "").replace(/^\+/, "");
  const dialCode = COUNTRY_DIAL_CODES[String(countryId)];

  if (dialCode && digits.startsWith(dialCode) && digits.length > dialCode.length + 4) {
    return digits.slice(dialCode.length);
  }

  return digits;
}

function normalizeCountries(payload) {
  if (!Array.isArray(payload)) return FALLBACK_COUNTRIES;

  const countries = payload
    .filter((country) => Number(country.visible) === 1 || Number(country.id) === 15)
    .map((country) => ({
      id: Number(country.id),
      name: String(country.eng || country.name || country.rus || `Country ${country.id}`),
      dialCode: COUNTRY_DIAL_CODES[String(country.id)] || ""
    }))
    .filter((country) => Number.isFinite(country.id) && country.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  return countries.length ? countries : FALLBACK_COUNTRIES;
}

function findBrowser(preferred) {
  const groups = {
    chromium: ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave-browser", "microsoft-edge"],
    firefox: ["firefox", "librewolf"]
  };

  const candidates = preferred && groups[preferred]
    ? groups[preferred]
    : [...groups.chromium, ...groups.firefox];

  for (const command of candidates) {
    const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
      encoding: "utf8"
    });

    if (result.status === 0 && result.stdout.trim()) {
      return { command, kind: groups.firefox.includes(command) ? "firefox" : "chromium" };
    }
  }

  return null;
}

function launchPrivateBrowser(preferred) {
  const browser = findBrowser(preferred);
  if (!browser) {
    throw new Error("No supported browser found. Install Firefox or Chromium.");
  }

  const args = browser.kind === "firefox"
    ? ["--private-window", WOLT_URL]
    : ["--incognito", "--new-window", "--window-size=980,980", "--window-position=20,20", WOLT_URL];

  const child = spawn(browser.command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  return browser;
}

async function handleApi(req, res, parsedUrl) {
  try {
    if (parsedUrl.pathname === "/api/config" && req.method === "GET") {
      const config = await loadConfig();
      return sendJson(res, 200, publicConfig(config));
    }

    if (parsedUrl.pathname === "/api/testmail/emails" && req.method === "GET") {
      const config = await loadConfig();
      const missing = missingKeys(config, ["testmail_api_key", "testmail_namespace"]);
      if (missing.length) {
        return sendJson(res, 400, { success: false, error: `Missing config: ${missing.join(", ")}` });
      }

      const limit = Math.max(1, Math.min(Number(parsedUrl.searchParams.get("limit") || 10), 50));
      const offset = Math.max(0, Number(parsedUrl.searchParams.get("offset") || 0));
      const data = await fetchTestmailEmails(config, limit, offset);
      const emails = sortedEmails(data).slice(0, limit).map(normalizeEmail);

      return sendJson(res, 200, {
        success: true,
        emails,
        count: emails.length,
        result_count: data.result_count ?? data.count ?? null
      });
    }

    if (parsedUrl.pathname === "/api/testmail/email" && req.method === "GET") {
      const config = await loadConfig();
      const missing = missingKeys(config, ["testmail_api_key", "testmail_namespace"]);
      if (missing.length) {
        return sendJson(res, 400, { success: false, error: `Missing config: ${missing.join(", ")}` });
      }

      const id = String(parsedUrl.searchParams.get("id") || "").trim();
      if (!id) return sendJson(res, 400, { success: false, error: "Missing email id" });

      const data = await fetchTestmailEmails(config, 25, 0);
      const emails = sortedEmails(data);
      const match = emails.find((email, index) => normalizeEmail(email, index).id === id);

      if (!match) return sendJson(res, 404, { success: false, error: "Email not found" });

      return sendJson(res, 200, {
        success: true,
        email: normalizeEmailDetail(match, emails.indexOf(match))
      });
    }

    if (parsedUrl.pathname === "/api/testmail/magic-link" && req.method === "GET") {
      const config = await loadConfig();
      const missing = missingKeys(config, ["testmail_api_key", "testmail_namespace"]);
      if (missing.length) {
        return sendJson(res, 400, { success: false, error: `Missing config: ${missing.join(", ")}` });
      }

      const target = String(parsedUrl.searchParams.get("email") || "").trim().toLowerCase();
      if (!target) return sendJson(res, 400, { success: false, error: "Missing email" });

      const data = await fetchTestmailEmails(config, 20, 0);
      const emails = sortedEmails(data);
      const matching = emails.filter((email) => recipientMatches(email, target));

      for (const email of matching) {
        const magicLink = extractMagicLink(email);
        if (magicLink) {
          await upsertAccount({
            email: target,
            magic_link: magicLink,
            magic_link_updated_at: new Date().toISOString()
          });

          return sendJson(res, 200, {
            success: true,
            status: "received",
            magic_link: magicLink,
            email: normalizeEmail(email, 0)
          });
        }
      }

      return sendJson(res, 200, { success: true, status: "waiting", magic_link: null });
    }

    if (parsedUrl.pathname === "/api/accounts" && req.method === "GET") {
      const accounts = await readAccounts();
      return sendJson(res, 200, { success: true, accounts });
    }

    if (parsedUrl.pathname === "/api/accounts" && req.method === "POST") {
      const body = await readJsonBody(req);
      const account = await upsertAccount(body);
      return sendJson(res, 200, { success: true, account });
    }

    if (parsedUrl.pathname === "/api/accounts" && req.method === "DELETE") {
      const email = String(parsedUrl.searchParams.get("email") || "").trim().toLowerCase();
      const deleted = await deleteAccount(email);
      return sendJson(res, 200, { success: true, deleted });
    }

    if (parsedUrl.pathname === "/api/accounts/magic-link" && req.method === "POST") {
      const config = await loadConfig();
      const missing = missingKeys(config, ["testmail_api_key", "testmail_namespace"]);
      if (missing.length) {
        return sendJson(res, 400, { success: false, error: `Missing config: ${missing.join(", ")}` });
      }

      const body = await readJsonBody(req);
      const target = String(body.email || "").trim().toLowerCase();
      if (!target) return sendJson(res, 400, { success: false, error: "Missing email" });

      const data = await fetchTestmailEmails(config, 30, 0);
      const emails = sortedEmails(data);
      const matching = emails.filter((email) => recipientMatches(email, target));

      for (const email of matching) {
        const magicLink = extractMagicLink(email, { kind: "login" });
        if (magicLink) {
          const account = await upsertAccount({
            email: target,
            login_magic_link: magicLink,
            login_magic_link_updated_at: new Date().toISOString(),
            login_magic_link_status: "received"
          });
          return sendJson(res, 200, {
            success: true,
            status: "received",
            magic_link: magicLink,
            account
          });
        }
      }

      await upsertAccount({ email: target, login_magic_link_status: "waiting" });
      return sendJson(res, 200, { success: true, status: "waiting", magic_link: null });
    }

    if (parsedUrl.pathname === "/api/browser/open" && req.method === "POST") {
      const body = await readJsonBody(req);
      const browser = launchPrivateBrowser(body.browser);
      return sendJson(res, 200, {
        success: true,
        browser: browser.command,
        private_mode: browser.kind === "firefox" ? "private-window" : "incognito"
      });
    }

    if (parsedUrl.pathname === "/api/sms/countries" && req.method === "GET") {
      const result = await heroRequest({ action: "getCountries" }, 15000);
      const countries = normalizeCountries(result.json);
      return sendJson(res, 200, { success: true, countries });
    }

    if (parsedUrl.pathname === "/api/sms/summary" && req.method === "GET") {
      const config = await loadConfig();
      const missing = missingKeys(config, ["sms_api_key"]);
      if (missing.length) {
        return sendJson(res, 400, { success: false, error: `Missing config: ${missing.join(", ")}` });
      }

      const country = String(parsedUrl.searchParams.get("country") || "15");
      const [balanceResult, priceResult] = await Promise.all([
        heroRequest({ api_key: config.sms_api_key, action: "getBalance" }, 15000),
        heroRequest({
          api_key: config.sms_api_key,
          action: "getPrices",
          service: WOLT_SERVICE,
          country
        }, 15000)
      ]);

      const balanceError = heroError(balanceResult);
      if (balanceError) return sendJson(res, 502, { success: false, error: balanceError });

      const balance = parseBalance(balanceResult);
      const priceError = heroError(priceResult);
      const priceData = priceError ? { price: null, count: null } : parsePriceData(priceResult.json, country, WOLT_SERVICE);
      const estimate =
        balance !== null && priceData.price
          ? Math.floor(balance / priceData.price)
          : null;

      return sendJson(res, 200, {
        success: true,
        balance,
        price: priceData.price,
        available: priceData.count,
        estimate,
        price_error: priceError || null
      });
    }

    if (parsedUrl.pathname === "/api/sms/request-number" && req.method === "POST") {
      const config = await loadConfig();
      const missing = missingKeys(config, ["sms_api_key"]);
      if (missing.length) {
        return sendJson(res, 400, { success: false, error: `Missing config: ${missing.join(", ")}` });
      }

      const body = await readJsonBody(req);
      const country = String(body.country || "15");
      const maxPrice = body.max_price ? String(body.max_price) : "";
      const params = {
        api_key: config.sms_api_key,
        action: "getNumberV2",
        service: WOLT_SERVICE,
        country
      };
      if (maxPrice) params.maxPrice = maxPrice;

      const result = await heroRequest(params, 20000);
      const error = heroError(result);
      if (error) return sendJson(res, 502, { success: false, error });

      let activationId = null;
      let phoneNumber = null;

      if (result.json && (result.json.activationId || result.json.phoneNumber)) {
        activationId = String(result.json.activationId || "");
        phoneNumber = String(result.json.phoneNumber || "");
      } else if (result.text.trim().startsWith("ACCESS_NUMBER_OK:")) {
        const parts = result.text.trim().split(":");
        activationId = parts[1] || "";
        phoneNumber = parts[2] || "";
      }

      if (!activationId || !phoneNumber) {
        return sendJson(res, 502, {
          success: false,
          error: result.text.trim() || "Unexpected Hero SMS response"
        });
      }

      const ready = await heroRequest({
        api_key: config.sms_api_key,
        action: "setStatus",
        id: activationId,
        status: "1"
      }, 15000);

      const readyError = heroError(ready);
      if (body.email) {
        await upsertAccount({
          email: body.email,
          phone_number: phoneNumber,
          local_phone_number: stripCountryCode(phoneNumber, country),
          activation_id: activationId,
          phone_country: country
        });
      }

      return sendJson(res, 200, {
        success: true,
        activation_id: activationId,
        phone_number: phoneNumber,
        local_phone_number: stripCountryCode(phoneNumber, country),
        ready: !readyError,
        ready_error: readyError || null
      });
    }

    if (parsedUrl.pathname === "/api/sms/status" && req.method === "GET") {
      const config = await loadConfig();
      const missing = missingKeys(config, ["sms_api_key"]);
      if (missing.length) {
        return sendJson(res, 400, { success: false, error: `Missing config: ${missing.join(", ")}` });
      }

      const id = String(parsedUrl.searchParams.get("id") || "").trim();
      if (!id) return sendJson(res, 400, { success: false, error: "Missing activation id" });

      const result = await heroRequest({
        api_key: config.sms_api_key,
        action: "getStatus",
        id
      }, 15000);
      const text = result.text.trim();

      if (text.startsWith("STATUS_OK:")) {
        return sendJson(res, 200, {
          success: true,
          status: "received",
          code: text.split(":").slice(1).join(":")
        });
      }

      if (text.startsWith("STATUS_WAIT")) {
        return sendJson(res, 200, { success: true, status: "waiting", code: null, raw_status: text });
      }

      const error = heroError(result) || text;
      return sendJson(res, 200, { success: false, status: "error", error });
    }

    return sendJson(res, 404, { success: false, error: "Not found" });
  } catch (error) {
    if (error.name === "AbortError") {
      return sendJson(res, 504, { success: false, error: "Upstream request timed out" });
    }

    if (error.code === "ENOENT" && error.path === CONFIG_PATH) {
      return sendJson(res, 500, { success: false, error: "Missing config.json" });
    }

    return sendJson(res, 500, { success: false, error: error.message || "Server error" });
  }
}

async function serveStatic(res, requestPath) {
  const safePath = path
    .normalize(decodeURIComponent(requestPath.split("?")[0]))
    .replace(/^(\.\.[/\\])+/, "");
  const relativePath = safePath === "/" ? "index.html" : safePath.replace(/^[/\\]/, "");
  const filePath = path.join(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return sendText(res, 404, "Not found");

    const body = await fs.readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return sendText(res, 404, "Not found");
    return sendText(res, 500, error.message || "Server error");
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (parsedUrl.pathname.startsWith("/api/")) {
    return handleApi(req, res, parsedUrl);
  }

  return serveStatic(res, parsedUrl.pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`esd.woltmanual running at http://127.0.0.1:${PORT}`);
});
