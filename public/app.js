const app = document.getElementById("app");

const FIRST_NAMES = ["Mads", "Frederik", "Emil", "Magnus", "Anders", "Sofie", "Ida", "Anna", "Laura", "Katrine"];
const LAST_NAMES = ["Jensen", "Nielsen", "Hansen", "Pedersen", "Andersen", "Christensen", "Larsen", "Moller", "Olsen", "Thomsen"];

const DEFAULT_VPN_COUNTRY = "Denmark";

const state = {
  step: 1,
  config: null,
  error: "",
  email: "",
  firstName: "",
  lastName: "",
  magicLink: "",
  magicStatus: "waiting",
  emails: [],
  selectedEmailId: "",
  selectedEmail: null,
  inboxLoading: false,
  inboxExpanded: false,
  emailDetailLoading: false,
  magicLoading: false,
  countries: [],
  country: "172",
  smsSummary: null,
  smsError: "",
  smsLoading: false,
  activationId: "",
  phoneNumber: "",
  localPhoneNumber: "",
  smsCode: "",
  smsStatus: "",
  accounts: [],
  accountMagicLoadingEmail: "",
  accountMagicExpandedEmail: "",
  accountDeleteConfirmEmail: "",
  toolPanel: "",
  browserStatus: "",
  fingerprint: null,
  toast: "",
  vpn: {
    loaded: false,
    available: true,
    loading: false,
    connected: false,
    status: "",
    country: "",
    city: "",
    server: "",
    hostname: "",
    ip: "",
    error: "",
    countries: [],
    selectedCountry: loadVpnCountryPref()
  }
};

let magicTimer = null;
let accountMagicTimer = null;
let vpnTimer = null;
let inboxTimer = null;
let smsTimer = null;
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) return "";
  const number = Number(value);
  const date = Number.isFinite(number) ? new Date(number) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function randomToken(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => chars[value % chars.length]).join("");
}

function randomChoice(items) {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return items[values[0] % items.length];
}

function generateIdentity() {
  state.firstName = randomChoice(FIRST_NAMES);
  state.lastName = randomChoice(LAST_NAMES);
}

async function generateEmail() {
  const provider = state.config?.email_provider || "testmail";
  if (provider === "tempmail") {
    const data = await api("/api/email/generate");
    state.email = data.email || "";
  } else {
    const namespace = state.config?.testmail_namespace || "";
    state.email = namespace ? `${namespace}.${randomToken()}@inbox.testmail.app` : "";
  }
  state.magicLink = "";
  state.magicStatus = "waiting";
  state.selectedEmail = null;
  state.selectedEmailId = "";
}

function canGenerateEmail() {
  if (!state.config) return false;
  return state.config.email_provider === "tempmail"
    ? state.config.has_tempmail_api_key
    : Boolean(state.config.testmail_namespace);
}

function emailProviderLabel() {
  return state.config?.email_provider === "tempmail" ? "tempmail" : "testmail";
}

function emailPatternLabel() {
  if (state.config?.email_provider === "tempmail") {
    return `random@${state.config?.tempmail_domain || "tempmail domain"}`;
  }
  return `namespace.${state.config?.testmail_namespace ? "random" : "missing"}@inbox.testmail.app`;
}

async function setDefaultEmailProvider(provider) {
  if (!provider || provider === state.config?.default_email_provider) return;
  state.error = "";
  try {
    state.config = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({ default_email_provider: provider })
    });
    await generateEmail();
    showToast(`Default set to ${emailProviderLabel()}`);
  } catch (error) {
    state.error = error.message;
    render();
  }
}

function tauriInvoke() {
  return new URLSearchParams(location.search).get("hub") === "1" ? null : window.__TAURI__?.core?.invoke;
}

async function api(path, options = {}) {
  const invoke = tauriInvoke();
  if (invoke) {
    const data = await invoke("api_request", {
      path,
      method: options.method || "GET",
      body: options.body || ""
    });
    if (data.success === false) {
      throw new Error(data.error || "Request failed");
    }
    return data;
  }

  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function copyText(text, label = "Copied") {
  await navigator.clipboard.writeText(String(text || ""));
  showToast(label);
}

function showToast(message) {
  state.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = "";
    render();
  }, 1300);
  render();
}

function clearPollers() {
  clearInterval(magicTimer);
  clearInterval(accountMagicTimer);
  clearInterval(inboxTimer);
  clearInterval(smsTimer);
  magicTimer = null;
  accountMagicTimer = null;
  inboxTimer = null;
  smsTimer = null;
}

function setStep(step) {
  clearPollers();
  state.step = step;
  render();

  if (step === 2) {
    refreshInbox();
    refreshMagicLink();
    magicTimer = setInterval(refreshMagicLink, 5000);
    inboxTimer = setInterval(refreshInbox, 8000);
  }

  if (step === 3) {
    loadSmsSummary();
    if (state.activationId && !state.smsCode) {
      refreshSmsStatus();
      smsTimer = setInterval(refreshSmsStatus, 5000);
    }
  }
}

function restart() {
  clearPollers();
  state.step = 1;
  state.magicLink = "";
  state.magicStatus = "waiting";
  state.emails = [];
  state.selectedEmail = null;
  state.selectedEmailId = "";
  state.smsSummary = null;
  state.smsError = "";
  state.activationId = "";
  state.phoneNumber = "";
  state.localPhoneNumber = "";
  state.smsCode = "";
  state.smsStatus = "";
  generateIdentity();
  generateEmail().catch((error) => {
    state.error = error.message;
    render();
  });
  render();
}

async function loadConfig() {
  try {
    state.config = await api("/api/config");
    if (state.config.missing?.length) {
      state.error = `Missing config: ${state.config.missing.join(", ")}`;
    }
    generateIdentity();
    await generateEmail();
  } catch (error) {
    state.error = error.message;
  }
}

async function loadCountries() {
  try {
    const data = await api("/api/sms/countries");
    state.countries = data.countries || [];
  } catch {
    state.countries = [
      { id: 15, name: "Poland", dialCode: "48" }
    ];
  }
}

async function loadAccounts() {
  try {
    const data = await api("/api/accounts");
    state.accounts = data.accounts || [];
  } catch {
    state.accounts = [];
  }
}

async function saveCurrentAccount(extra = {}) {
  if (!state.email) return;

  try {
    const data = await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        email: state.email,
        first_name: state.firstName,
        last_name: state.lastName,
        magic_link: state.magicLink,
        phone_number: state.phoneNumber,
        local_phone_number: state.localPhoneNumber,
        activation_id: state.activationId,
        ...extra
      })
    });
    const existing = state.accounts.filter((account) => account.email !== data.account.email);
    state.accounts = [data.account, ...existing];
  } catch (error) {
    state.error = error.message;
  }
}

async function refreshInbox() {
  if (state.inboxLoading) return;
  state.inboxLoading = true;
  render();

  try {
    const data = await api(`/api/email/emails?limit=10&offset=0&email=${encodeURIComponent(state.email)}`);
    state.emails = data.emails || [];
  } catch (error) {
    state.error = error.message;
  } finally {
    state.inboxLoading = false;
    render();
  }
}

async function loadEmailDetail(id) {
  if (!id) return;
  state.selectedEmailId = id;
  state.emailDetailLoading = true;
  render();

  try {
    const data = await api(`/api/email/email?id=${encodeURIComponent(id)}&email=${encodeURIComponent(state.email)}`);
    state.selectedEmail = data.email;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.emailDetailLoading = false;
    render();
  }
}

async function refreshMagicLink() {
  if (!state.email || state.magicLoading || state.magicLink) return;
  state.magicLoading = true;
  render();

  try {
    const data = await api(`/api/email/magic-link?email=${encodeURIComponent(state.email)}`);
    state.magicStatus = data.status || "waiting";
    if (data.magic_link) {
      state.magicLink = data.magic_link;
      await saveCurrentAccount({
        magic_link: data.magic_link,
        magic_link_updated_at: new Date().toISOString()
      });
    }
  } catch (error) {
    state.error = error.message;
  } finally {
    state.magicLoading = false;
    render();
  }
}

async function loadSmsSummary() {
  state.smsError = "";
  state.smsLoading = true;
  render();

  try {
    state.smsSummary = await api(`/api/sms/summary?country=${encodeURIComponent(state.country)}`);
  } catch (error) {
    state.smsError = error.message;
  } finally {
    state.smsLoading = false;
    render();
  }
}

async function requestNumber() {
  state.smsError = "";
  state.smsLoading = true;
  state.smsCode = "";
  state.smsStatus = "";
  render();

  try {
    const data = await api("/api/sms/request-number", {
      method: "POST",
      body: JSON.stringify({ country: state.country, email: state.email })
    });
    state.activationId = data.activation_id;
    state.phoneNumber = data.phone_number;
    state.localPhoneNumber = data.local_phone_number;
    state.smsStatus = "waiting";
    await saveCurrentAccount({
      phone_number: data.phone_number,
      local_phone_number: data.local_phone_number,
      activation_id: data.activation_id,
      phone_country: state.country
    });
    clearInterval(smsTimer);
    refreshSmsStatus();
    smsTimer = setInterval(refreshSmsStatus, 5000);
  } catch (error) {
    state.smsError = error.message;
  } finally {
    state.smsLoading = false;
    render();
  }
}

async function refreshSmsStatus() {
  if (!state.activationId || state.smsCode) return;

  try {
    const data = await api(`/api/sms/status?id=${encodeURIComponent(state.activationId)}`);
    state.smsStatus = data.status;
    if (data.code) {
      state.smsCode = data.code;
      clearInterval(smsTimer);
      smsTimer = null;
    }
  } catch (error) {
    state.smsStatus = "error";
    state.smsError = error.message;
  } finally {
    render();
  }
}

async function openWolt(browser = "") {
  state.browserStatus = "opening";
  state.fingerprint = null;
  render();

  try {
    const data = await api("/api/browser/open", {
      method: "POST",
      body: JSON.stringify({ browser })
    });
    state.browserStatus = `${data.browser} ${data.private_mode}`;
    state.fingerprint = data.fingerprint || null;
    showToast("Wolt opened");
  } catch (error) {
    state.browserStatus = error.message;
    render();
  }
}

async function fetchAccountMagic(email, options = {}) {
  state.accountMagicLoadingEmail = email;
  state.accountMagicExpandedEmail = email;
  render();

  try {
    const data = await api("/api/accounts/magic-link", {
      method: "POST",
      body: JSON.stringify({ email })
    });

    await loadAccounts();
    if (!data.magic_link && !options.silent) showToast("Waiting for magic link");
  } catch (error) {
    state.error = error.message;
  } finally {
    state.accountMagicLoadingEmail = "";
    render();
  }
}

function stopAccountMagicPolling() {
  clearInterval(accountMagicTimer);
  accountMagicTimer = null;
}

function startAccountMagicPolling(email) {
  stopAccountMagicPolling();
  accountMagicTimer = setInterval(async () => {
    const account = state.accounts.find((item) => item.email === email);
    if (state.accountMagicExpandedEmail !== email || account?.login_magic_link) {
      stopAccountMagicPolling();
      return;
    }
    await fetchAccountMagic(email, { silent: true });
  }, 5000);
}

async function copyAccountMagic(email) {
  const account = state.accounts.find((item) => item.email === email);
  if (account?.login_magic_link) {
    await copyText(account.login_magic_link, "Magic link copied");
    return;
  }

  await fetchAccountMagic(email);
  const updated = state.accounts.find((item) => item.email === email);
  if (updated?.login_magic_link) await copyText(updated.login_magic_link, "Magic link copied");
}

async function deleteAccount(email) {
  try {
    await api(`/api/accounts?email=${encodeURIComponent(email)}`, { method: "DELETE" });
    state.accounts = state.accounts.filter((account) => account.email !== email);
    if (state.accountMagicExpandedEmail === email) {
      state.accountMagicExpandedEmail = "";
      stopAccountMagicPolling();
    }
    state.accountDeleteConfirmEmail = "";
    showToast("Account deleted");
  } catch (error) {
    state.error = error.message;
    render();
  }
}

function loadVpnCountryPref() {
  try {
    return localStorage.getItem("woltmanual.vpn_country") || DEFAULT_VPN_COUNTRY;
  } catch {
    return DEFAULT_VPN_COUNTRY;
  }
}

function saveVpnCountryPref(value) {
  try {
    localStorage.setItem("woltmanual.vpn_country", value);
  } catch {
    // ignore storage errors (e.g. private browsing restrictions)
  }
}

function applyVpnStatus(data) {
  state.vpn.available = true;
  state.vpn.connected = Boolean(data.connected);
  state.vpn.status = data.status || (state.vpn.connected ? "Connected" : "Disconnected");
  state.vpn.country = data.country || "";
  state.vpn.city = data.city || "";
  state.vpn.server = data.server || "";
  state.vpn.hostname = data.hostname || "";
  state.vpn.ip = data.ip || "";
  state.vpn.error = "";
}

async function refreshVpnStatus() {
  try {
    const data = await api("/api/vpn/status");
    applyVpnStatus(data);
  } catch (error) {
    state.vpn.available = !/not found/i.test(error.message || "");
    state.vpn.connected = false;
    state.vpn.status = "";
    state.vpn.error = error.message;
  } finally {
    state.vpn.loaded = true;
    render();
  }
}

async function loadVpnCountries() {
  try {
    const data = await api("/api/vpn/countries");
    state.vpn.countries = data.countries || [];
  } catch {
    state.vpn.countries = [{ id: DEFAULT_VPN_COUNTRY, name: DEFAULT_VPN_COUNTRY }];
  } finally {
    render();
  }
}

async function vpnConnect() {
  state.vpn.loading = true;
  state.vpn.error = "";
  render();

  try {
    const data = await api("/api/vpn/connect", {
      method: "POST",
      body: JSON.stringify({ country: state.vpn.selectedCountry || DEFAULT_VPN_COUNTRY })
    });
    applyVpnStatus(data);
    showToast(`VPN connected: ${data.country || state.vpn.selectedCountry}`);
  } catch (error) {
    state.vpn.error = error.message;
  } finally {
    state.vpn.loading = false;
    render();
  }
}

async function vpnDisconnect() {
  state.vpn.loading = true;
  state.vpn.error = "";
  render();

  try {
    const data = await api("/api/vpn/disconnect", { method: "POST" });
    applyVpnStatus(data);
    showToast("VPN disconnected");
  } catch (error) {
    state.vpn.error = error.message;
  } finally {
    state.vpn.loading = false;
    render();
  }
}

function stepClass(step) {
  if (state.step === step) return "step active";
  if (state.step > step) return "step done";
  return "step";
}

function vpnDotClass() {
  if (!state.vpn.available) return "vpn-dot error";
  if (state.vpn.loading) return "vpn-dot connecting";
  return state.vpn.connected ? "vpn-dot connected" : "vpn-dot disconnected";
}

function vpnStatusText() {
  if (!state.vpn.available) return state.vpn.error || "NordVPN not available";
  if (state.vpn.loading) return "Reconnecting...";
  if (state.vpn.connected) {
    const location = [state.vpn.country, state.vpn.city].filter(Boolean).join(" · ");
    return [location, state.vpn.ip].filter(Boolean).join(" — ") || "Connected";
  }
  return state.vpn.error || (state.vpn.loaded ? "Disconnected" : "Checking...");
}

function renderVpnCountryOptions() {
  const countries = state.vpn.countries.length
    ? state.vpn.countries
    : [{ id: DEFAULT_VPN_COUNTRY, name: DEFAULT_VPN_COUNTRY }];
  return countries.map((country) => {
    const selected = country.id === state.vpn.selectedCountry ? "selected" : "";
    return `<option value="${escapeHtml(country.id)}" ${selected}>${escapeHtml(country.name)}</option>`;
  }).join("");
}

function renderVpnBar() {
  const disableActions = state.vpn.loading || !state.vpn.available;
  return `
    <div class="vpn-bar">
      <div class="vpn-status">
        <span class="${vpnDotClass()}"></span>
        <div class="vpn-info">
          <strong>NordVPN</strong>
          <span>${escapeHtml(vpnStatusText())}</span>
        </div>
      </div>
      <div class="vpn-controls">
        <select data-action="vpn-country" aria-label="VPN country" ${disableActions ? "disabled" : ""}>${renderVpnCountryOptions()}</select>
        <button class="secondary" data-action="vpn-connect" ${disableActions ? "disabled" : ""}>Reconnect</button>
        <button class="ghost" data-action="vpn-disconnect" ${disableActions || !state.vpn.connected ? "disabled" : ""}>Disconnect</button>
      </div>
    </div>
  `;
}

function layout(content) {
  const toast = state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : "";
  const accountButtonClass = state.toolPanel === "accounts" ? "secondary active" : "secondary";

  return `
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <strong>Woltmanual</strong>
          <span>${escapeHtml(`${emailProviderLabel()}: ${state.config?.email_label || "not configured"}`)}</span>
        </div>
        <div class="top-actions">
          <button class="secondary" data-action="open-wolt">Open Wolt</button>
          <button class="${accountButtonClass}" data-action="toggle-accounts">Accounts</button>
          <button class="secondary" data-action="restart">Restart</button>
        </div>
      </header>

      ${renderVpnBar()}
      ${renderToolPanel()}
      ${state.fingerprint ? renderFingerprint() : ""}

      <section class="page-area">
        <nav class="steps" aria-label="Steps">
          <button class="${stepClass(1)}" data-action="goto-step" data-step="1"><span class="step-index">01</span><span>Email</span></button>
          <button class="${stepClass(2)}" data-action="goto-step" data-step="2"><span class="step-index">02</span><span>Magic link</span></button>
          <button class="${stepClass(3)}" data-action="goto-step" data-step="3"><span class="step-index">03</span><span>Phone</span></button>
        </nav>

        ${state.error ? `<div class="error">${escapeHtml(state.error)}</div><br>` : ""}
        ${content}
      </section>
      ${toast}
    </main>
  `;
}

function renderEmailStep() {
  const provider = state.config?.default_email_provider || state.config?.email_provider || "testmail";
  return layout(`
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Email</div>
        <div class="status-line">${escapeHtml(emailPatternLabel())}</div>
      </div>
      <div class="panel-body stack">
        <div class="field">
          <div class="label">Default email provider</div>
          <div class="provider-switch" role="group" aria-label="Email provider">
            <button class="${provider === "testmail" ? "active" : "secondary"}" data-action="set-default-provider" data-provider="testmail">Testmail${provider === "testmail" ? " default" : ""}</button>
            <button class="${provider === "tempmail" ? "active" : "secondary"}" data-action="set-default-provider" data-provider="tempmail">Temp Mail${provider === "tempmail" ? " default" : ""}</button>
          </div>
        </div>
        <div class="field">
          <div class="label">Generated email</div>
          <div class="copy-row">
            <div class="value-box large">${escapeHtml(state.email || `Missing ${emailProviderLabel()} config`)}</div>
            <button data-action="copy-email" ${state.email ? "" : "disabled"}>Copy</button>
          </div>
        </div>
        <div class="actions">
          <div class="actions-left">
            <button class="secondary" data-action="new-email" ${canGenerateEmail() ? "" : "disabled"}>New email</button>
          </div>
        </div>
      </div>
    </section>
  `);
}

function renderMagicPanel() {
  const status = state.magicLink
    ? `<span class="ok">received</span>`
    : `<span>${state.magicLoading ? "checking" : "waiting"}</span>`;

  const body = state.magicLink
    ? `
      <div class="copy-row">
        <div class="value-box">${escapeHtml(state.magicLink)}</div>
        <button data-action="copy-magic">Copy</button>
      </div>
    `
    : `<div class="value-box">Waiting for ${escapeHtml(state.email)}</div>`;

  return `
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Wolt magic link</div>
        <div class="status-line">${status}</div>
      </div>
      <div class="panel-body stack">
        ${body}
        <div class="actions">
          <div class="actions-right">
            <button class="secondary" data-action="refresh-inbox">Refresh</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderInbox() {
  const rows = state.emails.length
    ? state.emails.map((email) => `
      <button class="mail-row ${email.id === state.selectedEmailId ? "selected" : ""}" data-action="select-mail" data-id="${escapeHtml(email.id)}">
        <div class="mail-head">
          <div class="mail-subject">${escapeHtml(email.subject)}</div>
          <div class="mail-date">${escapeHtml(formatDate(email.date))}</div>
        </div>
        <div class="mail-meta">
          <div>from: ${escapeHtml(email.from || "-")}</div>
          <div>to: ${escapeHtml(email.to || "-")}</div>
        </div>
        <div class="mail-preview">${escapeHtml(email.preview || "")}</div>
      </button>
    `).join("")
    : `<div class="value-box">${state.inboxLoading ? "Loading" : "No emails"}</div>`;

  return `
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Inbox</div>
        <div class="status-line">${state.inboxLoading ? "refreshing" : `${state.emails.length}/10`}</div>
      </div>
      <div class="panel-body">
        <div class="inbox-list">${rows}</div>
      </div>
    </section>
  `;
}

function renderMailSection() {
  const status = state.inboxLoading ? "refreshing" : `${state.emails.length}/10`;

  if (!state.inboxExpanded) {
    return `
      <section class="panel mail-section-toggle">
        <div class="panel-header">
          <div class="panel-title">Emails</div>
          <div class="panel-actions">
            <div class="status-line">${status}</div>
            <button class="ghost" data-action="toggle-inbox">Expand</button>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="mail-section-expanded">
      <div class="mail-section-bar">
        <div>
          <div class="panel-title">Emails</div>
          <div class="status-line">${status}</div>
        </div>
        <button class="ghost active" data-action="toggle-inbox">Collapse</button>
      </div>
      <div class="mail-layout">
        ${renderInbox()}
        ${renderEmailDetail()}
      </div>
    </section>
  `;
}

function renderEmailDetail() {
  if (state.emailDetailLoading) {
    return `
      <section class="panel">
        <div class="panel-header"><div class="panel-title">Mail</div></div>
        <div class="panel-body"><div class="value-box">Loading</div></div>
      </section>
    `;
  }

  if (!state.selectedEmail) {
    return `
      <section class="panel">
        <div class="panel-header"><div class="panel-title">Mail</div></div>
        <div class="panel-body"><div class="value-box">Select a mail</div></div>
      </section>
    `;
  }

  const email = state.selectedEmail;
  const links = (email.links || []).length
    ? email.links.map((link) => `
      <div class="link-row">
        <div class="value-box">${escapeHtml(link)}</div>
        <button data-copy="${escapeHtml(link)}">Copy</button>
      </div>
    `).join("")
    : `<div class="value-box">No links</div>`;

  return `
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Mail</div>
        <div class="status-line">${escapeHtml(formatDate(email.date))}</div>
      </div>
      <div class="panel-body stack">
        <div class="mail-detail-meta">
          <div><span class="label">subject</span><br>${escapeHtml(email.subject)}</div>
          <div><span class="label">from</span><br>${escapeHtml(email.from || "-")}</div>
          <div><span class="label">to</span><br>${escapeHtml(email.to || "-")}</div>
        </div>
        <div class="field">
          <div class="label">Links</div>
          <div class="link-list">${links}</div>
        </div>
        <div class="field">
          <div class="label">Content</div>
          <pre class="mail-content">${escapeHtml(email.text || email.html_text || "")}</pre>
        </div>
      </div>
    </section>
  `;
}

function renderMagicStep() {
  return layout(`
    <div class="stack">
      ${renderMagicPanel()}
      ${renderMailSection()}
    </div>
  `);
}

function metric(label, value) {
  return `
    <div class="metric">
      <div class="label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value ?? "-")}</div>
    </div>
  `;
}

function renderCountryOptions() {
  const countries = state.countries.length ? state.countries : [{ id: 15, name: "Poland", dialCode: "48" }];
  return countries.map((country) => {
    const selected = String(country.id) === String(state.country) ? "selected" : "";
    const suffix = country.dialCode ? ` +${country.dialCode}` : "";
    return `<option value="${escapeHtml(country.id)}" ${selected}>${escapeHtml(country.name + suffix)}</option>`;
  }).join("");
}

function renderPhoneDetails() {
  if (!state.activationId) {
    return `<div class="value-box">No number generated</div>`;
  }

  const sms = state.smsCode
    ? `
      <div class="field">
        <div class="label">SMS</div>
        <div class="copy-row">
          <div class="value-box large ok">${escapeHtml(state.smsCode)}</div>
          <button data-action="copy-sms">Copy</button>
        </div>
      </div>
    `
    : `
      <div class="field">
        <div class="label">SMS</div>
        <div class="value-box">${escapeHtml(state.smsStatus || "waiting")}</div>
      </div>
    `;

  return `
    <div class="stack">
      <div class="field">
        <div class="label">Phone number</div>
        <div class="copy-row">
          <div class="value-box large">${escapeHtml(state.localPhoneNumber || state.phoneNumber)}</div>
          <button data-action="copy-number">Copy</button>
        </div>
      </div>
      ${sms}
    </div>
  `;
}

function renderPhoneStep() {
  const summary = state.smsSummary || {};
  const balance = summary.balance === null || summary.balance === undefined ? "-" : summary.balance;
  const price = summary.price === null || summary.price === undefined ? "-" : summary.price;
  const estimate = summary.estimate === null || summary.estimate === undefined ? "-" : summary.estimate;

  return layout(`
    <section class="phone-layout">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">Hero SMS</div>
          <div class="status-line">${state.smsLoading ? "loading" : "ready"}</div>
        </div>
        <div class="panel-body stack">
          <div class="field">
            <div class="label">Nationality</div>
            <select data-action="country">${renderCountryOptions()}</select>
          </div>
          <div class="grid-3">
            ${metric("Balance", balance)}
            ${metric("Price", price)}
            ${metric("Est.", estimate)}
          </div>
          ${state.smsError ? `<div class="error">${escapeHtml(state.smsError)}</div>` : ""}
          <button data-action="request-number" ${state.smsLoading ? "disabled" : ""}>Generate number</button>
          <div class="actions">
            <div class="actions-right">
              <button class="secondary" data-action="refresh-sms">Refresh</button>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">Number</div>
          <div class="status-line">${state.activationId ? escapeHtml(state.activationId) : "-"}</div>
        </div>
        <div class="panel-body">
          ${renderPhoneDetails()}
        </div>
      </div>
    </section>
  `);
}

function renderToolPanel() {
  if (!state.toolPanel) return "";
  return `
    <section class="tool-panel">
      ${renderAccountsPanel()}
    </section>
  `;
}

function renderAccountsPanel() {
  const rows = state.accounts.length
    ? state.accounts.map((account) => {
      const isMagicExpanded = state.accountMagicExpandedEmail === account.email;
      const isConfirmingDelete = state.accountDeleteConfirmEmail === account.email;
      const loginMagicLink = account.login_magic_link || "";
      const magicValue = loginMagicLink || "Waiting for magic link";

      return `
      <div class="account-row ${isMagicExpanded ? "expanded" : ""}">
        <div class="account-main">
          <strong>${escapeHtml(account.email)}</strong>
          <span>${escapeHtml(formatDate(account.updated_at))}</span>
        </div>
        <div class="account-actions">
          <button data-copy="${escapeHtml(account.email)}">Email</button>
          <button class="secondary" data-action="account-magic" data-email="${escapeHtml(account.email)}" ${state.accountMagicLoadingEmail === account.email ? "disabled" : ""}>Get magic</button>
          ${isConfirmingDelete
            ? `<button class="danger" data-action="confirm-delete-account" data-email="${escapeHtml(account.email)}">Sure?</button>`
            : `<button class="danger ghost" data-action="delete-account" data-email="${escapeHtml(account.email)}">Delete</button>`}
        </div>
        ${isMagicExpanded ? `
          <div class="account-magic-panel">
            <input readonly value="${escapeHtml(magicValue)}" aria-label="Login magic link">
            <button data-action="copy-account-magic" data-email="${escapeHtml(account.email)}" ${state.accountMagicLoadingEmail === account.email ? "disabled" : ""}>Copy</button>
          </div>
        ` : ""}
      </div>
    `;
    }).join("")
    : `<div class="value-box">No generated accounts</div>`;

  return `
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">Generated accounts</div>
        <button class="ghost" data-action="close-tools">Close</button>
      </div>
      <div class="panel-body stack">
        <div class="actions">
          <div class="actions-left">
            <button class="secondary" data-action="save-account">Save current</button>
            <button class="secondary" data-action="refresh-accounts">Refresh</button>
          </div>
          <div class="actions-right">
            <button data-action="open-wolt">Open Wolt</button>
          </div>
        </div>
        <div class="account-list">${rows}</div>
      </div>
    </div>
  `;
}

function renderFingerprint() {
  const fp = state.fingerprint;
  if (!fp) return "";

  const features = (fp.features_disabled || []).map((feat) =>
    `<span class="chip">${escapeHtml(feat)}</span>`
  ).join("");

  const uaDisplay = fp.user_agent
    ? fp.user_agent.length > 90
      ? `${escapeHtml(fp.user_agent.slice(0, 87))}...`
      : escapeHtml(fp.user_agent)
    : "Firefox (resistFingerprinting)";

  return `
    <div class="fingerprint-panel">
      <div class="fingerprint-header">
        <div class="fingerprint-title">Browser fingerprint</div>
        <button class="ghost" data-action="close-fingerprint" title="Dismiss">close</button>
      </div>
      <div class="fingerprint-grid">
        <div class="fp-item">
          <div class="label">User agent</div>
          <div class="fp-value" title="${escapeHtml(fp.user_agent || '')}">${uaDisplay}</div>
        </div>
        <div class="fp-item">
          <div class="label">Profile</div>
          <div class="fp-value">${escapeHtml(fp.profile_dir)}</div>
        </div>
        <div class="fp-row">
          <div class="fp-item narrow">
            <div class="label">Window</div>
            <div class="fp-value">${fp.width}x${fp.height}</div>
          </div>
          <div class="fp-item narrow">
            <div class="label">Position</div>
            <div class="fp-value">${fp.pos_x},${fp.pos_y}</div>
          </div>
          <div class="fp-item narrow">
            <div class="label">Language</div>
            <div class="fp-value">${escapeHtml(fp.lang)}</div>
          </div>
        </div>
        <div class="fp-row">
          <div class="fp-item narrow">
            <div class="label">WebGL</div>
            <div class="fp-value ${fp.gl_renderer.toLowerCase().includes('disabled') ? 'warn' : ''}">${escapeHtml(fp.gl_renderer)}</div>
          </div>
          <div class="fp-item narrow">
            <div class="label">WebRTC</div>
            <div class="fp-value ${fp.webrtc_policy.toLowerCase().includes('disable') || fp.webrtc_policy === 'disabled' ? 'ok' : ''}">${escapeHtml(fp.webrtc_policy)}</div>
          </div>
          <div class="fp-item narrow">
            <div class="label">Canvas read</div>
            <div class="fp-value ok">${fp.canvas_blocked ? "blocked" : "allowed"}</div>
          </div>
        </div>
        ${features ? `
          <div class="fp-item">
            <div class="label">Features disabled</div>
            <div class="fp-chips">${features}</div>
          </div>
        ` : ""}
      </div>
    </div>
  `;
}

function bindActions() {
  document.querySelectorAll("[data-action]").forEach((element) => {
    const action = element.dataset.action;

    if (action === "restart") element.addEventListener("click", restart);
    if (action === "open-wolt") element.addEventListener("click", () => openWolt());
    if (action === "toggle-accounts") element.addEventListener("click", async () => {
      state.toolPanel = state.toolPanel === "accounts" ? "" : "accounts";
      if (state.toolPanel === "accounts") {
        await loadAccounts();
      } else {
        state.accountMagicExpandedEmail = "";
        state.accountDeleteConfirmEmail = "";
        stopAccountMagicPolling();
      }
      render();
    });
    if (action === "close-tools") element.addEventListener("click", () => {
      state.toolPanel = "";
      state.accountMagicExpandedEmail = "";
      state.accountDeleteConfirmEmail = "";
      stopAccountMagicPolling();
      render();
    });
    if (action === "close-fingerprint") element.addEventListener("click", () => {
      state.fingerprint = null;
      render();
    });
    if (action === "new-email") element.addEventListener("click", async () => {
      try {
        await generateEmail();
      } catch (error) {
        state.error = error.message;
      }
      render();
    });
    if (action === "set-default-provider") element.addEventListener("click", () => setDefaultEmailProvider(element.dataset.provider));
    if (action === "copy-email") element.addEventListener("click", async () => {
      await copyText(state.email, "Email copied");
      await saveCurrentAccount({ status: "generated" });
      setStep(2);
    });
    if (action === "copy-magic") element.addEventListener("click", async () => {
      await copyText(state.magicLink, "Magic link copied");
      await saveCurrentAccount({
        magic_link: state.magicLink,
        magic_link_updated_at: new Date().toISOString()
      });
      setStep(3);
    });
    if (action === "copy-number") element.addEventListener("click", () => copyText(state.localPhoneNumber || state.phoneNumber, "Number copied"));
    if (action === "copy-sms") element.addEventListener("click", () => copyText(state.smsCode, "SMS copied"));
    if (action === "goto-step") element.addEventListener("click", () => setStep(Number(element.dataset.step)));
    if (action === "refresh-inbox") element.addEventListener("click", () => {
      refreshInbox();
      refreshMagicLink();
    });
    if (action === "toggle-inbox") element.addEventListener("click", () => {
      state.inboxExpanded = !state.inboxExpanded;
      render();
    });
    if (action === "select-mail") element.addEventListener("click", () => loadEmailDetail(element.dataset.id));
    if (action === "refresh-sms") element.addEventListener("click", () => {
      loadSmsSummary();
      refreshSmsStatus();
    });
    if (action === "request-number") element.addEventListener("click", requestNumber);
    if (action === "save-account") element.addEventListener("click", async () => {
      await saveCurrentAccount({ status: "generated" });
      await loadAccounts();
      render();
    });
    if (action === "refresh-accounts") element.addEventListener("click", async () => {
      await loadAccounts();
      render();
    });
    if (action === "account-magic") element.addEventListener("click", async () => {
      await fetchAccountMagic(element.dataset.email);
      startAccountMagicPolling(element.dataset.email);
    });
    if (action === "copy-account-magic") element.addEventListener("click", () => copyAccountMagic(element.dataset.email));
    if (action === "delete-account") element.addEventListener("click", () => {
      state.accountDeleteConfirmEmail = element.dataset.email;
      render();
    });
    if (action === "confirm-delete-account") element.addEventListener("click", () => deleteAccount(element.dataset.email));
    if (action === "country") element.addEventListener("change", (event) => {
      state.country = event.target.value;
      state.activationId = "";
      state.phoneNumber = "";
      state.localPhoneNumber = "";
      state.smsCode = "";
      state.smsStatus = "";
      clearInterval(smsTimer);
      loadSmsSummary();
    });
    if (action === "vpn-country") element.addEventListener("change", (event) => {
      state.vpn.selectedCountry = event.target.value;
      saveVpnCountryPref(state.vpn.selectedCountry);
    });
    if (action === "vpn-connect") element.addEventListener("click", vpnConnect);
    if (action === "vpn-disconnect") element.addEventListener("click", vpnDisconnect);
  });

  document.querySelectorAll("[data-copy]").forEach((element) => {
    element.addEventListener("click", () => copyText(element.dataset.copy, "Copied"));
  });
}

function render() {
  if (!state.config && !state.error) {
    app.innerHTML = layout(`<section class="panel"><div class="panel-body">Loading</div></section>`);
    bindActions();
    return;
  }

  if (state.step === 1) app.innerHTML = renderEmailStep();
  if (state.step === 2) app.innerHTML = renderMagicStep();
  if (state.step === 3) app.innerHTML = renderPhoneStep();
  bindActions();
}

async function init() {
  const saved = await window.hubIntegration?.initial;
  render();
  await Promise.all([
    loadConfig(),
    loadCountries(),
    loadAccounts(),
    loadVpnCountries(),
    refreshVpnStatus(),
  ]);
  render();
  if (saved?.app) Object.assign(state, saved.app);
  setStep(state.step);
  vpnTimer = setInterval(refreshVpnStatus, 20000);
  window.hubIntegration?.install({
    capture: () => {
      const { config, accounts, countries, ...session } = state;
      return session;
    },
    pause: () => {
      clearPollers();
      clearInterval(vpnTimer);
    },
    resume: () => {
      setStep(state.step);
      clearInterval(vpnTimer);
      vpnTimer = setInterval(refreshVpnStatus, 20000);
    },
  });
  window.hubIntegration?.restoreForms(saved);
}

init();
