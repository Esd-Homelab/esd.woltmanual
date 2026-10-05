use chrono::Utc;
use rand::Rng;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{json, Map, Value};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use url::Url;
use std::time::{SystemTime, UNIX_EPOCH};

type ApiResult<T> = Result<T, String>;

const HERO_BASE: &str = "https://hero-sms.com/stubs/handler_api.php";
const TESTMAIL_BASE: &str = "https://api.testmail.app/api/json";
const DEFAULT_EMAIL_PROVIDER: &str = "testmail";
const RAPIDAPI_TEMPMAIL_HOST: &str = "privatix-temp-mail-v1.p.rapidapi.com";
const RAPIDAPI_TEMPMAIL_BASE: &str = "https://privatix-temp-mail-v1.p.rapidapi.com";
const WOLT_SERVICE: &str = "rr";
const WOLT_URL: &str = "https://wolt.com";
const DEFAULT_VPN_COUNTRY: &str = "Denmark";

#[derive(Clone, Debug)]
struct Config {
    sms_api_key: String,
    default_email_provider: String,
    email_provider: String,
    testmail_api_key: String,
    testmail_namespace: String,
    tempmail_api_key: String,
    tempmail_domain: String,
}

#[derive(Debug)]
struct FetchResult {
    status: u16,
    text: String,
    json: Option<Value>,
}

impl FetchResult {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

#[derive(Debug)]
struct PriceData {
    price: Option<f64>,
    count: Option<f64>,
}

#[derive(Debug)]
struct Browser {
    command: String,
    kind: String,
}

#[derive(Debug)]
struct Fingerprint {
    user_agent: String,
    profile_dir: String,
    width: u32,
    height: u32,
    pos_x: i32,
    pos_y: i32,
    lang: String,
    gl_renderer: String,
    webrtc_policy: String,
    canvas_blocked: bool,
    features_disabled: Vec<String>,
}

#[tauri::command]
async fn api_request(
    app: AppHandle,
    path: String,
    method: Option<String>,
    body: Option<String>,
) -> Value {
    match handle_api(
        &app,
        &path,
        method.as_deref().unwrap_or("GET"),
        body.as_deref(),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => json!({ "success": false, "error": error }),
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![api_request])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn handle_api(
    app: &AppHandle,
    path: &str,
    method: &str,
    body: Option<&str>,
) -> ApiResult<Value> {
    let parsed_url = Url::parse(&format!("http://localhost{path}"))
        .map_err(|error| format!("Invalid request path: {error}"))?;
    let pathname = parsed_url.path();
    let method = method.to_uppercase();
    let body = parse_body(body)?;

    if pathname == "/api/config" && method == "GET" {
        let config = load_config(app)?;
        return Ok(public_config(&config));
    }

    if pathname == "/api/config" && method == "POST" {
        let provider = body_string(&body, "default_email_provider")
            .or_else(|| body_string(&body, "email_provider"))
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if !["testmail", "tempmail"].contains(&provider.as_str()) {
            return Ok(json!({ "success": false, "error": "Invalid email provider" }));
        }

        let config = update_config(app, &provider)?;
        return Ok(public_config(&config));
    }

    if pathname == "/api/email/generate" && method == "GET" {
        let config = load_config(app)?;
        let missing = missing_email_config(&config);
        if !missing.is_empty() {
            return Ok(error_json(format!(
                "Missing config: {}",
                missing.join(", ")
            )));
        }

        return Ok(json!({
            "success": true,
            "email": generate_email_address(&config).await?,
            "provider": get_email_provider(&config)
        }));
    }

    if (pathname == "/api/email/emails" || pathname == "/api/testmail/emails") && method == "GET" {
        let config = load_config(app)?;
        let missing = missing_email_config(&config);
        if !missing.is_empty() {
            return Ok(error_json(format!(
                "Missing config: {}",
                missing.join(", ")
            )));
        }

        let limit = query_number(&parsed_url, "limit", 10.0).clamp(1.0, 50.0) as usize;
        let offset = query_number(&parsed_url, "offset", 0.0).max(0.0) as usize;
        let target = query_param(&parsed_url, "email").trim().to_lowercase();
        if get_email_provider(&config) == "tempmail" && target.is_empty() {
            return Ok(error_json("Missing email"));
        }

        let raw_emails = fetch_provider_emails(&config, &target, limit, offset).await?;
        let emails = sorted_emails(raw_emails.clone())
            .into_iter()
            .take(limit)
            .enumerate()
            .map(|(index, email)| normalize_email(&email, index))
            .collect::<Vec<_>>();

        return Ok(json!({
            "success": true,
            "emails": emails,
            "count": emails.len(),
            "result_count": if raw_emails.is_empty() { Value::Null } else { json!(raw_emails.len()) }
        }));
    }

    if (pathname == "/api/email/email" || pathname == "/api/testmail/email") && method == "GET" {
        let config = load_config(app)?;
        let missing = missing_email_config(&config);
        if !missing.is_empty() {
            return Ok(error_json(format!(
                "Missing config: {}",
                missing.join(", ")
            )));
        }

        let id = query_param(&parsed_url, "id").trim().to_string();
        if id.is_empty() {
            return Ok(error_json("Missing email id"));
        }

        let target = query_param(&parsed_url, "email").trim().to_lowercase();
        if get_email_provider(&config) == "tempmail" && target.is_empty() {
            return Ok(error_json("Missing email"));
        }

        let emails = sorted_emails(fetch_provider_emails(&config, &target, 25, 0).await?);
        for (index, email) in emails.iter().enumerate() {
            if value_string(&normalize_email(email, index), "id") == id {
                return Ok(json!({
                    "success": true,
                    "email": normalize_email_detail(email, index)
                }));
            }
        }

        return Ok(error_json("Email not found"));
    }

    if (pathname == "/api/email/magic-link" || pathname == "/api/testmail/magic-link")
        && method == "GET"
    {
        let config = load_config(app)?;
        let missing = missing_email_config(&config);
        if !missing.is_empty() {
            return Ok(error_json(format!(
                "Missing config: {}",
                missing.join(", ")
            )));
        }

        let target = query_param(&parsed_url, "email").trim().to_lowercase();
        if target.is_empty() {
            return Ok(error_json("Missing email"));
        }

        let emails = sorted_emails(fetch_provider_emails(&config, &target, 20, 0).await?);
        let matching = emails
            .into_iter()
            .filter(|email| recipient_matches(email, &target))
            .collect::<Vec<_>>();

        for email in matching {
            if let Some(magic_link) = extract_magic_link(&email, None) {
                upsert_account(
                    app,
                    json!({
                        "email": target,
                        "magic_link": magic_link,
                        "magic_link_updated_at": Utc::now().to_rfc3339()
                    }),
                )?;

                return Ok(json!({
                    "success": true,
                    "status": "received",
                    "magic_link": magic_link,
                    "email": normalize_email(&email, 0)
                }));
            }
        }

        return Ok(json!({ "success": true, "status": "waiting", "magic_link": Value::Null }));
    }

    if pathname == "/api/accounts" && method == "GET" {
        let accounts = read_accounts(app)?;
        return Ok(json!({ "success": true, "accounts": accounts }));
    }

    if pathname == "/api/accounts" && method == "POST" {
        let account = upsert_account(app, body)?;
        return Ok(json!({ "success": true, "account": account }));
    }

    if pathname == "/api/accounts" && method == "DELETE" {
        let email = query_param(&parsed_url, "email").trim().to_lowercase();
        let deleted = delete_account(app, &email)?;
        return Ok(json!({ "success": true, "deleted": deleted }));
    }

    if pathname == "/api/accounts/magic-link" && method == "POST" {
        let config = load_config(app)?;
        let missing = missing_email_config(&config);
        if !missing.is_empty() {
            return Ok(error_json(format!(
                "Missing config: {}",
                missing.join(", ")
            )));
        }

        let target = body_string(&body, "email")
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if target.is_empty() {
            return Ok(error_json("Missing email"));
        }

        let emails = sorted_emails(fetch_provider_emails(&config, &target, 30, 0).await?);
        let matching = emails
            .into_iter()
            .filter(|email| recipient_matches(email, &target))
            .collect::<Vec<_>>();

        for email in matching {
            if let Some(magic_link) = extract_magic_link(&email, Some("login")) {
                let account = upsert_account(
                    app,
                    json!({
                        "email": target,
                        "login_magic_link": magic_link,
                        "login_magic_link_updated_at": Utc::now().to_rfc3339(),
                        "login_magic_link_status": "received"
                    }),
                )?;

                return Ok(json!({
                    "success": true,
                    "status": "received",
                    "magic_link": magic_link,
                    "account": account
                }));
            }
        }

        upsert_account(
            app,
            json!({
                "email": target,
                "login_magic_link_status": "waiting"
            }),
        )?;
        return Ok(json!({ "success": true, "status": "waiting", "magic_link": Value::Null }));
    }

    if pathname == "/api/browser/open" && method == "POST" {
        let preferred = body_string(&body, "browser").unwrap_or_default();
        let (browser, fp) = launch_private_browser(&preferred)?;
        return Ok(json!({
            "success": true,
            "browser": browser.command,
            "private_mode": if browser.kind == "firefox" { "private-window" } else { "incognito" },
            "fingerprint": {
                "user_agent": fp.user_agent,
                "profile_dir": fp.profile_dir,
                "width": fp.width,
                "height": fp.height,
                "pos_x": fp.pos_x,
                "pos_y": fp.pos_y,
                "lang": fp.lang,
                "gl_renderer": fp.gl_renderer,
                "webrtc_policy": fp.webrtc_policy,
                "canvas_blocked": fp.canvas_blocked,
                "features_disabled": fp.features_disabled
            }
        }));
    }

    if pathname == "/api/sms/countries" && method == "GET" {
        let result = hero_request(&[("action", "getCountries")], 15_000).await?;
        let countries = normalize_countries(result.json.as_ref());
        return Ok(json!({ "success": true, "countries": countries }));
    }

    if pathname == "/api/sms/summary" && method == "GET" {
        let config = load_config(app)?;
        let missing = missing_keys(&config, &["sms_api_key"]);
        if !missing.is_empty() {
            return Ok(error_json(format!(
                "Missing config: {}",
                missing.join(", ")
            )));
        }

        let country = query_param_default(&parsed_url, "country", "172");
        let balance_result = hero_request(
            &[
                ("api_key", config.sms_api_key.as_str()),
                ("action", "getBalance"),
            ],
            15_000,
        )
        .await?;
        let price_result = hero_request(
            &[
                ("api_key", config.sms_api_key.as_str()),
                ("action", "getPrices"),
                ("service", WOLT_SERVICE),
                ("country", country.as_str()),
            ],
            15_000,
        )
        .await?;

        let balance_error = hero_error(&balance_result);
        if !balance_error.is_empty() {
            return Ok(error_json(balance_error));
        }

        let balance = parse_balance(&balance_result);
        let price_error = hero_error(&price_result);
        let price_data = if price_error.is_empty() {
            parse_price_data(price_result.json.as_ref(), &country, WOLT_SERVICE)
        } else {
            PriceData {
                price: None,
                count: None,
            }
        };
        let estimate = match (balance, price_data.price) {
            (Some(balance), Some(price)) if price != 0.0 => Some((balance / price).floor() as i64),
            _ => None,
        };

        return Ok(json!({
            "success": true,
            "balance": balance,
            "price": price_data.price,
            "available": price_data.count,
            "estimate": estimate,
            "price_error": if price_error.is_empty() { Value::Null } else { json!(price_error) }
        }));
    }

    if pathname == "/api/sms/request-number" && method == "POST" {
        let config = load_config(app)?;
        let missing = missing_keys(&config, &["sms_api_key"]);
        if !missing.is_empty() {
            return Ok(error_json(format!(
                "Missing config: {}",
                missing.join(", ")
            )));
        }

        let country = body_string(&body, "country").unwrap_or_else(|| "172".to_string());
        let max_price = body_string(&body, "max_price").unwrap_or_default();
        let mut params = vec![
            ("api_key", config.sms_api_key.as_str()),
            ("action", "getNumberV2"),
            ("service", WOLT_SERVICE),
            ("country", country.as_str()),
        ];
        if !max_price.is_empty() {
            params.push(("maxPrice", max_price.as_str()));
        }

        let result = hero_request(&params, 20_000).await?;
        let error = hero_error(&result);
        if !error.is_empty() {
            return Ok(error_json(error));
        }

        let (activation_id, phone_number) = parse_activation(&result);
        if activation_id.is_empty() || phone_number.is_empty() {
            return Ok(error_json(if result.text.trim().is_empty() {
                "Unexpected Hero SMS response".to_string()
            } else {
                result.text.trim().to_string()
            }));
        }

        let ready = hero_request(
            &[
                ("api_key", config.sms_api_key.as_str()),
                ("action", "setStatus"),
                ("id", activation_id.as_str()),
                ("status", "1"),
            ],
            15_000,
        )
        .await?;
        let ready_error = hero_error(&ready);
        let local_phone_number = strip_country_code(&phone_number, &country);

        if let Some(email) = body_string(&body, "email") {
            if !email.trim().is_empty() {
                upsert_account(
                    app,
                    json!({
                        "email": email,
                        "phone_number": phone_number,
                        "local_phone_number": local_phone_number,
                        "activation_id": activation_id,
                        "phone_country": country
                    }),
                )?;
            }
        }

        return Ok(json!({
            "success": true,
            "activation_id": activation_id,
            "phone_number": phone_number,
            "local_phone_number": local_phone_number,
            "ready": ready_error.is_empty(),
            "ready_error": if ready_error.is_empty() { Value::Null } else { json!(ready_error) }
        }));
    }

    if pathname == "/api/sms/status" && method == "GET" {
        let config = load_config(app)?;
        let missing = missing_keys(&config, &["sms_api_key"]);
        if !missing.is_empty() {
            return Ok(error_json(format!(
                "Missing config: {}",
                missing.join(", ")
            )));
        }

        let id = query_param(&parsed_url, "id").trim().to_string();
        if id.is_empty() {
            return Ok(error_json("Missing activation id"));
        }

        let result = hero_request(
            &[
                ("api_key", config.sms_api_key.as_str()),
                ("action", "getStatus"),
                ("id", id.as_str()),
            ],
            15_000,
        )
        .await?;
        let text = result.text.trim();

        if let Some(code) = text.strip_prefix("STATUS_OK:") {
            return Ok(json!({ "success": true, "status": "received", "code": code }));
        }

        if text.starts_with("STATUS_WAIT") {
            return Ok(
                json!({ "success": true, "status": "waiting", "code": Value::Null, "raw_status": text }),
            );
        }

        let error = {
            let parsed = hero_error(&result);
            if parsed.is_empty() {
                text.to_string()
            } else {
                parsed
            }
        };
        return Ok(json!({ "success": false, "status": "error", "error": error }));
    }

    if pathname == "/api/vpn/status" && method == "GET" {
        return match vpn_status_value() {
            Ok(value) => Ok(value),
            Err(error) => Ok(error_json(error)),
        };
    }

    if pathname == "/api/vpn/countries" && method == "GET" {
        let (ok, text) = nordvpn_run(&["countries"])?;
        if !ok {
            return Ok(error_json(if text.is_empty() {
                "Failed to list VPN countries".to_string()
            } else {
                text
            }));
        }

        let countries = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| json!({ "id": line, "name": line.replace('_', " ") }))
            .collect::<Vec<_>>();

        return Ok(json!({ "success": true, "countries": countries }));
    }

    if pathname == "/api/vpn/connect" && method == "POST" {
        let country = body_string(&body, "country")
            .unwrap_or_default()
            .trim()
            .to_string();
        let country = if country.is_empty() {
            DEFAULT_VPN_COUNTRY.to_string()
        } else {
            country
        };

        let (ok, message) = nordvpn_run(&["connect", &country])?;
        if !ok {
            return Ok(error_json(if message.is_empty() {
                "Failed to connect".to_string()
            } else {
                message
            }));
        }

        let mut status = vpn_status_value()?;
        if let Value::Object(ref mut map) = status {
            map.insert("message".to_string(), json!(message));
        }
        return Ok(status);
    }

    if pathname == "/api/vpn/disconnect" && method == "POST" {
        let (ok, message) = nordvpn_run(&["disconnect"])?;
        if !ok {
            return Ok(error_json(if message.is_empty() {
                "Failed to disconnect".to_string()
            } else {
                message
            }));
        }

        let mut status = vpn_status_value()?;
        if let Value::Object(ref mut map) = status {
            map.insert("message".to_string(), json!(message));
        }
        return Ok(status);
    }

    Ok(error_json("Not found"))
}

fn parse_body(body: Option<&str>) -> ApiResult<Value> {
    match body.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            serde_json::from_str(value).map_err(|error| format!("Invalid JSON body: {error}"))
        }
        None => Ok(json!({})),
    }
}

fn error_json(error: impl Into<String>) -> Value {
    json!({ "success": false, "error": error.into() })
}

fn query_param(url: &Url, key: &str) -> String {
    url.query_pairs()
        .find_map(|(name, value)| (name == key).then(|| value.into_owned()))
        .unwrap_or_default()
}

fn query_param_default(url: &Url, key: &str, default_value: &str) -> String {
    let value = query_param(url, key);
    if value.is_empty() {
        default_value.to_string()
    } else {
        value
    }
}

fn query_number(url: &Url, key: &str, default_value: f64) -> f64 {
    query_param(url, key)
        .parse::<f64>()
        .unwrap_or(default_value)
}

fn body_string(body: &Value, key: &str) -> Option<String> {
    body.get(key)
        .map(value_to_text)
        .filter(|value| !value.is_empty())
}

fn value_string(value: &Value, key: &str) -> String {
    value.get(key).map(value_to_text).unwrap_or_default()
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        other => other.to_string(),
    }
}

fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(root) = env::var("ESD_WOLTMANUAL_ROOT") {
        return PathBuf::from(root);
    }

    let current_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut candidates = vec![current_dir.clone()];
    if let Some(parent) = current_dir.parent() {
        candidates.push(parent.to_path_buf());
    }

    if let Ok(executable) = env::current_exe() {
        for ancestor in executable.ancestors().skip(1).take(6) {
            let ancestor = ancestor.to_path_buf();
            if !candidates.iter().any(|candidate| candidate == &ancestor) {
                candidates.push(ancestor);
            }
        }
    }

    for candidate in candidates {
        if candidate.join("package.json").is_file() && candidate.join("public").is_dir() {
            return candidate;
        }

        if candidate.join("config.json").is_file() {
            return candidate;
        }
    }

    app.path().app_config_dir().unwrap_or_else(|_| current_dir)
}

fn config_path(app: &AppHandle) -> PathBuf {
    resolve_data_dir(app).join("config.json")
}

fn accounts_path(app: &AppHandle) -> PathBuf {
    resolve_data_dir(app).join("accounts.json")
}

fn read_json(path: &Path) -> ApiResult<Value> {
    let text = fs::read_to_string(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound
            && path.file_name().and_then(|name| name.to_str()) == Some("config.json")
        {
            "Missing config.json".to_string()
        } else {
            error.to_string()
        }
    })?;
    serde_json::from_str(&clean_config_json(&text)).map_err(|error| error.to_string())
}

fn write_json(path: &Path, value: &Value) -> ApiResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())
}

fn clean_config_json(text: &str) -> String {
    let trimmed = text.trim_start_matches('\u{feff}');
    Regex::new(r",\s*([}\]])")
        .expect("valid trailing comma regex")
        .replace_all(trimmed, "$1")
        .into_owned()
}

fn load_config(app: &AppHandle) -> ApiResult<Config> {
    let parsed = read_json(&config_path(app))?;
    Ok(normalize_config(&parsed))
}

fn normalize_config(parsed: &Value) -> Config {
    let default_email_provider = get_email_provider_from_value(
        parsed
            .get("default_email_provider")
            .or_else(|| parsed.get("email_provider")),
    );
    let parsed_tempmail_api_key = string_field(parsed, "tempmail_api_key");
    let tempmail_api_key = if parsed_tempmail_api_key.is_empty() {
        env::var("TEMPMAIL_API_KEY")
            .unwrap_or_default()
            .trim()
            .to_string()
    } else {
        parsed_tempmail_api_key
    };

    Config {
        sms_api_key: string_field(parsed, "sms_api_key"),
        default_email_provider: default_email_provider.to_string(),
        email_provider: default_email_provider.to_string(),
        testmail_api_key: string_field(parsed, "testmail_api_key"),
        testmail_namespace: string_field(parsed, "testmail_namespace"),
        tempmail_api_key,
        tempmail_domain: string_field(parsed, "tempmail_domain"),
    }
}

fn string_field(parsed: &Value, key: &str) -> String {
    parsed
        .get(key)
        .map(value_to_text)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn update_config(app: &AppHandle, provider: &str) -> ApiResult<Config> {
    let path = config_path(app);
    let mut parsed = read_json(&path)?;
    if !parsed.is_object() {
        parsed = json!({});
    }

    if let Some(object) = parsed.as_object_mut() {
        object.insert("default_email_provider".to_string(), json!(provider));
        object.insert("email_provider".to_string(), json!(provider));
    }

    write_json(&path, &parsed)?;
    Ok(normalize_config(&parsed))
}

fn get_email_provider(config: &Config) -> &str {
    if config.email_provider == "tempmail" {
        "tempmail"
    } else {
        DEFAULT_EMAIL_PROVIDER
    }
}

fn get_email_provider_from_value(value: Option<&Value>) -> &'static str {
    if value.map(value_to_text).unwrap_or_default() == "tempmail" {
        "tempmail"
    } else {
        DEFAULT_EMAIL_PROVIDER
    }
}

fn config_field<'a>(config: &'a Config, key: &str) -> &'a str {
    match key {
        "sms_api_key" => &config.sms_api_key,
        "testmail_api_key" => &config.testmail_api_key,
        "testmail_namespace" => &config.testmail_namespace,
        "tempmail_api_key" => &config.tempmail_api_key,
        "tempmail_domain" => &config.tempmail_domain,
        _ => "",
    }
}

fn missing_keys(config: &Config, keys: &[&str]) -> Vec<String> {
    keys.iter()
        .filter(|key| config_field(config, key).is_empty())
        .map(|key| (*key).to_string())
        .collect()
}

fn missing_email_config(config: &Config) -> Vec<String> {
    if get_email_provider(config) == "tempmail" {
        missing_keys(config, &["tempmail_api_key"])
    } else {
        missing_keys(config, &["testmail_api_key", "testmail_namespace"])
    }
}

fn public_config(config: &Config) -> Value {
    let email_provider = get_email_provider(config);
    let tempmail_domain = if config.tempmail_domain == RAPIDAPI_TEMPMAIL_HOST {
        ""
    } else {
        &config.tempmail_domain
    };
    let mut missing = missing_keys(config, &["sms_api_key"]);
    missing.extend(missing_email_config(config));

    json!({
        "success": true,
        "default_email_provider": config.default_email_provider,
        "email_provider": email_provider,
        "testmail_namespace": config.testmail_namespace,
        "tempmail_domain": tempmail_domain,
        "email_label": if email_provider == "tempmail" {
            if tempmail_domain.is_empty() { "tempmail" } else { tempmail_domain }
        } else {
            &config.testmail_namespace
        },
        "has_sms_api_key": !config.sms_api_key.is_empty(),
        "has_testmail_api_key": !config.testmail_api_key.is_empty(),
        "has_tempmail_api_key": !config.tempmail_api_key.is_empty(),
        "missing": missing
    })
}

async fn fetch_url(
    url: Url,
    headers: Option<HeaderMap>,
    timeout_ms: u64,
) -> ApiResult<FetchResult> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(url);
    if let Some(headers) = headers {
        request = request.headers(headers);
    }

    let response = request.send().await.map_err(request_error)?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(request_error)?;
    let json = serde_json::from_str(&text).ok();

    Ok(FetchResult { status, text, json })
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Upstream request timed out".to_string()
    } else {
        error.to_string()
    }
}

async fn hero_request(params: &[(&str, &str)], timeout_ms: u64) -> ApiResult<FetchResult> {
    let mut url = Url::parse(HERO_BASE).map_err(|error| error.to_string())?;
    url.query_pairs_mut().extend_pairs(params.iter().copied());
    fetch_url(url, None, timeout_ms).await
}

fn hero_error(result: &FetchResult) -> String {
    if let Some(json) = &result.json {
        if let Some(title) = json
            .get("title")
            .map(value_to_text)
            .filter(|value| !value.is_empty())
        {
            let details = json.get("details").map(value_to_text).unwrap_or_default();
            return [title, details]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(": ");
        }
    }

    let text = result.text.trim();
    if text.starts_with("BAD_")
        || text.starts_with("NO_")
        || text.starts_with("WRONG_")
        || text.starts_with("ERROR_")
        || text.contains("UNPROCESSABLE_ENTITY")
    {
        return text.to_string();
    }

    String::new()
}

fn parse_number_text(value: &str) -> Option<f64> {
    let normalized = value.replace(',', ".");
    let regex = Regex::new(r"-?\d+(?:\.\d+)?").expect("valid number regex");
    regex
        .find(&normalized)
        .and_then(|match_value| match_value.as_str().parse::<f64>().ok())
}

fn parse_number_value(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| {
        if let Some(number) = value.as_f64() {
            Some(number)
        } else {
            parse_number_text(&value_to_text(value))
        }
    })
}

fn parse_balance(result: &FetchResult) -> Option<f64> {
    if let Some(json) = &result.json {
        let direct = json
            .get("balance")
            .or_else(|| json.get("BALANCE"))
            .or_else(|| json.get("money"))
            .or_else(|| json.get("amount"))
            .or_else(|| json.pointer("/data/balance"));
        if let Some(parsed) = parse_number_value(direct) {
            return Some(parsed);
        }
    }

    let text = result.text.trim();
    if let Some(balance) = text.strip_prefix("ACCESS_BALANCE:") {
        return parse_number_text(balance);
    }

    parse_number_text(text)
}

fn read_price_object(candidate: Option<&Value>) -> Option<PriceData> {
    let candidate = candidate?;
    if !candidate.is_object() {
        return None;
    }

    let price = parse_number_value(candidate.get("cost"))
        .or_else(|| parse_number_value(candidate.get("price")))
        .or_else(|| parse_number_value(candidate.get("retailPrice")))
        .or_else(|| parse_number_value(candidate.get("amount")));
    let count = parse_number_value(candidate.get("count"))
        .or_else(|| parse_number_value(candidate.get("quantity")))
        .or_else(|| parse_number_value(candidate.get("available")));

    if price.is_none() && count.is_none() {
        None
    } else {
        Some(PriceData { price, count })
    }
}

fn parse_price_data(json: Option<&Value>, country: &str, service: &str) -> PriceData {
    let Some(json) = json else {
        return PriceData {
            price: None,
            count: None,
        };
    };

    let direct_candidates = [
        json.get(country).and_then(|value| value.get(service)),
        json.get(service).and_then(|value| value.get(country)),
        json.get(service),
        json.get(country),
        json.pointer(&format!("/data/{country}/{service}")),
        json.pointer(&format!("/data/{service}/{country}")),
    ];

    for candidate in direct_candidates {
        if let Some(price) = read_price_object(candidate) {
            return price;
        }
    }

    let mut stack = vec![json];
    while let Some(current) = stack.pop() {
        if current.is_object() {
            let current_service = current
                .get("service")
                .or_else(|| current.get("serviceCode"))
                .map(value_to_text)
                .unwrap_or_default();
            let current_country = current
                .get("country")
                .or_else(|| current.get("countryId"))
                .map(value_to_text)
                .unwrap_or_default();
            let matches_service = current_service.is_empty() || current_service == service;
            let matches_country = current_country.is_empty() || current_country == country;

            if let Some(price) = read_price_object(Some(current)) {
                if matches_service && matches_country {
                    return price;
                }
            }

            if let Some(object) = current.as_object() {
                stack.extend(object.values());
            }
        } else if let Some(array) = current.as_array() {
            stack.extend(array.iter());
        }
    }

    PriceData {
        price: None,
        count: None,
    }
}

async fn fetch_testmail_emails(config: &Config, limit: usize, offset: usize) -> ApiResult<Value> {
    let mut url = Url::parse(TESTMAIL_BASE).map_err(|error| error.to_string())?;
    let limit = limit.to_string();
    let offset = offset.to_string();
    url.query_pairs_mut()
        .append_pair("apikey", &config.testmail_api_key)
        .append_pair("namespace", &config.testmail_namespace)
        .append_pair("pretty", "true")
        .append_pair("limit", &limit)
        .append_pair("offset", &offset);

    let result = fetch_url(url, None, 15_000).await?;
    if !result.ok() {
        return Err(format!(
            "Testmail API returned {}: {}",
            result.status,
            result.text.chars().take(500).collect::<String>()
        ));
    }

    Ok(result.json.unwrap_or_else(|| json!({})))
}

async fn tempmail_request(config: &Config, endpoint: &str) -> ApiResult<Value> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "X-RapidAPI-Host",
        HeaderValue::from_static(RAPIDAPI_TEMPMAIL_HOST),
    );
    headers.insert(
        "X-RapidAPI-Key",
        HeaderValue::from_str(&config.tempmail_api_key).map_err(|error| error.to_string())?,
    );

    let url = Url::parse(&format!("{RAPIDAPI_TEMPMAIL_BASE}{endpoint}"))
        .map_err(|error| error.to_string())?;
    let result = fetch_url(url, Some(headers), 15_000).await?;
    if !result.ok() {
        return Err(format!(
            "Temp Mail API returned {}: {}",
            result.status,
            result.text.chars().take(500).collect::<String>()
        ));
    }

    Ok(result.json.unwrap_or(Value::Null))
}

async fn get_tempmail_domain(config: &Config) -> ApiResult<String> {
    if !config.tempmail_domain.is_empty() && config.tempmail_domain != RAPIDAPI_TEMPMAIL_HOST {
        return Ok(config.tempmail_domain.trim_start_matches('@').to_string());
    }

    let payload = tempmail_request(config, "/request/domains/").await?;
    let domains = unwrap_array(&payload)
        .into_iter()
        .map(|domain| {
            if domain.is_object() {
                domain
                    .get("domain")
                    .or_else(|| domain.get("name"))
                    .map(value_to_text)
                    .unwrap_or_default()
            } else {
                value_to_text(&domain)
            }
        })
        .map(|domain| domain.trim_start_matches('@').to_string())
        .filter(|domain| !domain.is_empty())
        .collect::<Vec<_>>();

    domains
        .into_iter()
        .next()
        .ok_or_else(|| "Temp Mail API did not return any domains".to_string())
}

async fn fetch_tempmail_emails(config: &Config, address: &str) -> ApiResult<Vec<Value>> {
    let digest = format!("{:x}", md5::compute(address.to_lowercase()));
    let payload = tempmail_request(config, &format!("/request/mail/id/{digest}/")).await?;
    Ok(unwrap_array(&payload)
        .into_iter()
        .enumerate()
        .map(|(index, email)| {
            json!({
                "id": field_or(&email, &["id", "mail_id", "messageId"], format!("{}-{index}", field_or(&email, &["date", "timestamp"], "tempmail".to_string()))),
                "from": field_or(&email, &["from", "mail_from", "sender"], String::new()),
                "to": field_or(&email, &["to", "mail_to"], address.to_string()),
                "subject": field_or(&email, &["subject", "mail_subject"], "(no subject)".to_string()),
                "date": field_value_or_null(&email, &["date", "mail_date", "mail_timestamp", "timestamp"]),
                "text": field_or(&email, &["text", "mail_text_only", "mail_text", "body"], String::new()),
                "html": field_or(&email, &["html", "mail_html"], String::new())
            })
        })
        .collect())
}

async fn generate_email_address(config: &Config) -> ApiResult<String> {
    let token = random_token(10);
    if get_email_provider(config) == "tempmail" {
        Ok(format!("{token}@{}", get_tempmail_domain(config).await?))
    } else {
        Ok(format!(
            "{}.{token}@inbox.testmail.app",
            config.testmail_namespace
        ))
    }
}

async fn fetch_provider_emails(
    config: &Config,
    target: &str,
    limit: usize,
    offset: usize,
) -> ApiResult<Vec<Value>> {
    if get_email_provider(config) == "tempmail" {
        fetch_tempmail_emails(config, target).await
    } else {
        let data = fetch_testmail_emails(config, limit, offset).await?;
        Ok(data
            .get("emails")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }
}

fn random_token(length: usize) -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

fn unwrap_array(payload: &Value) -> Vec<Value> {
    if let Some(array) = payload.as_array() {
        return array.clone();
    }

    for key in ["emails", "messages", "mail", "data", "result"] {
        if let Some(array) = payload.get(key).and_then(Value::as_array) {
            return array.clone();
        }
    }

    Vec::new()
}

fn sorted_emails(mut emails: Vec<Value>) -> Vec<Value> {
    emails.sort_by(|a, b| {
        numeric_email_date(b)
            .partial_cmp(&numeric_email_date(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    emails
}

fn numeric_email_date(email: &Value) -> f64 {
    parse_number_value(email.get("date").or_else(|| email.get("timestamp"))).unwrap_or(0.0)
}

fn strip_html(input: &str) -> String {
    let without_style = Regex::new(r"(?is)<style[\s\S]*?</style>")
        .expect("valid style regex")
        .replace_all(input, " ");
    let without_script = Regex::new(r"(?is)<script[\s\S]*?</script>")
        .expect("valid script regex")
        .replace_all(&without_style, " ");
    let without_tags = Regex::new(r"(?is)<[^>]+>")
        .expect("valid tag regex")
        .replace_all(&without_script, " ");
    Regex::new(r"\s+")
        .expect("valid whitespace regex")
        .replace_all(&without_tags, " ")
        .trim()
        .to_string()
}

fn decode_html_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn clean_url(input: &str) -> String {
    decode_html_entities(input)
        .replace("\\u0026", "&")
        .replace("\\/", "/")
        .trim_end_matches(|character| matches!(character, ')' | ']' | '.' | ',' | ';'))
        .to_string()
}

fn is_login_magic_link(link: &str) -> bool {
    if let Ok(url) = Url::parse(link) {
        return !url.query_pairs().any(|(key, _)| key == "new_user");
    }

    !Regex::new(r"(?i)[?&]new_user=")
        .expect("valid new user regex")
        .is_match(link)
}

fn extract_magic_link(email: &Value, kind: Option<&str>) -> Option<String> {
    let blocks = ["html", "text", "headers"]
        .into_iter()
        .filter_map(|key| email.get(key).map(value_to_text))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let href_regex = Regex::new(r#"(?i)href=["']([^"']*wolt\.com/me/magic_login[^"']*)["']"#)
        .expect("valid magic href regex");
    let url_regex = Regex::new(r#"(?i)https?://(?:www\.)?wolt\.com/me/magic_login[^\s"'<>]+"#)
        .expect("valid magic url regex");

    for block in blocks {
        let decoded = decode_html_entities(&block);
        for capture in href_regex.captures_iter(&decoded) {
            let link = clean_url(
                capture
                    .get(1)
                    .map(|value| value.as_str())
                    .unwrap_or_default(),
            );
            if kind != Some("login") || is_login_magic_link(&link) {
                return Some(link);
            }
        }

        for match_value in url_regex.find_iter(&decoded) {
            let link = clean_url(match_value.as_str());
            if kind != Some("login") || is_login_magic_link(&link) {
                return Some(link);
            }
        }
    }

    None
}

fn extract_links(email: &Value) -> Vec<String> {
    let blocks = ["html", "text"]
        .into_iter()
        .filter_map(|key| email.get(key).map(value_to_text))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let href_regex = Regex::new(r#"(?i)href=["']([^"']+)["']"#).expect("valid href regex");
    let url_regex = Regex::new(r#"(?i)https?://[^\s"'<>]+"#).expect("valid url regex");
    let mut links = Vec::new();

    for block in blocks {
        let decoded = decode_html_entities(&block);
        for capture in href_regex.captures_iter(&decoded) {
            let link = clean_url(
                capture
                    .get(1)
                    .map(|value| value.as_str())
                    .unwrap_or_default(),
            );
            if link.starts_with("http://") || link.starts_with("https://") {
                push_unique(&mut links, link);
            }
        }

        for match_value in url_regex.find_iter(&decoded) {
            push_unique(&mut links, clean_url(match_value.as_str()));
        }
    }

    links
}

fn push_unique(items: &mut Vec<String>, item: String) {
    if !items.iter().any(|existing| existing == &item) {
        items.push(item);
    }
}

fn email_recipient(email: &Value) -> String {
    let recipient = email
        .get("envelope_to")
        .or_else(|| email.get("to"))
        .or_else(|| email.get("recipient"));

    match recipient {
        Some(Value::Array(items)) => items
            .iter()
            .map(value_to_text)
            .collect::<Vec<_>>()
            .join(", "),
        Some(value) => value_to_text(value),
        None => String::new(),
    }
}

fn recipient_matches(email: &Value, target: &str) -> bool {
    let recipient = email_recipient(email).to_lowercase();
    let parts = Regex::new(r"[\s,;<>]+")
        .expect("valid recipient split regex")
        .split(&recipient)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    recipient == target || parts.iter().any(|part| *part == target)
}

fn normalize_email(email: &Value, index: usize) -> Value {
    let text = strip_html(&field_or(email, &["text", "html"], String::new()));
    json!({
        "id": field_or(email, &["id", "messageId"], format!("{}-{index}", field_or(email, &["date", "timestamp"], "mail".to_string()))),
        "from": field_or(email, &["from"], String::new()),
        "to": email_recipient(email),
        "subject": field_or(email, &["subject"], "(no subject)".to_string()),
        "date": field_value_or_null(email, &["date", "timestamp"]),
        "preview": text.chars().take(220).collect::<String>(),
        "has_magic_link": extract_magic_link(email, None).is_some()
    })
}

fn normalize_email_detail(email: &Value, index: usize) -> Value {
    let text_content = field_or(email, &["text"], String::new()).trim().to_string();
    let html_content = field_or(email, &["html"], String::new()).trim().to_string();
    let mut normalized = normalize_email(email, index);
    let object = normalized.as_object_mut().expect("normalized email object");
    object.insert(
        "text".to_string(),
        json!(if text_content.is_empty() {
            strip_html(&html_content)
        } else {
            text_content
        }),
    );
    object.insert("html_text".to_string(), json!(strip_html(&html_content)));
    object.insert("links".to_string(), json!(extract_links(email)));
    object.insert(
        "magic_link".to_string(),
        extract_magic_link(email, None)
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    normalized
}

fn field_or(value: &Value, keys: &[&str], fallback: String) -> String {
    keys.iter()
        .find_map(|key| {
            value
                .get(key)
                .map(value_to_text)
                .filter(|text| !text.is_empty())
        })
        .unwrap_or(fallback)
}

fn field_value_or_null(value: &Value, keys: &[&str]) -> Value {
    keys.iter()
        .find_map(|key| value.get(key).cloned())
        .unwrap_or(Value::Null)
}

fn country_dial_code(id: &str) -> &'static str {
    match id {
        "1" => "380",
        "2" => "7",
        "3" => "86",
        "4" => "63",
        "6" => "62",
        "7" => "60",
        "8" => "254",
        "10" => "84",
        "11" => "996",
        "13" => "972",
        "14" => "852",
        "15" => "48",
        "16" => "44",
        "19" => "234",
        "21" => "20",
        "22" => "91",
        "23" => "353",
        "24" => "855",
        "29" => "381",
        "31" => "27",
        "32" => "40",
        "33" => "57",
        "34" => "372",
        "36" => "1",
        "37" => "212",
        "39" => "54",
        "40" => "998",
        "43" => "49",
        "44" => "370",
        "46" => "46",
        "48" => "31",
        "49" => "371",
        "56" => "34",
        "63" => "420",
        "78" => "33",
        "86" => "39",
        "163" => "358",
        "172" => "45",
        "174" => "47",
        "187" => "1",
        _ => "",
    }
}

fn fallback_countries() -> Vec<Value> {
    vec![
        json!({ "id": 15, "name": "Poland", "dialCode": "48" }),
        json!({ "id": 172, "name": "Denmark", "dialCode": "45" }),
        json!({ "id": 46, "name": "Sweden", "dialCode": "46" }),
        json!({ "id": 43, "name": "Germany", "dialCode": "49" }),
        json!({ "id": 48, "name": "Netherlands", "dialCode": "31" }),
        json!({ "id": 16, "name": "United Kingdom", "dialCode": "44" }),
        json!({ "id": 78, "name": "France", "dialCode": "33" }),
        json!({ "id": 187, "name": "USA", "dialCode": "1" }),
    ]
}

fn normalize_countries(payload: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(countries)) = payload else {
        return fallback_countries();
    };

    let mut normalized = countries
        .iter()
        .filter_map(|country| {
            let id = parse_number_value(country.get("id"))? as i64;
            let visible = parse_number_value(country.get("visible")).unwrap_or(0.0) as i64;
            if visible != 1 && id != 15 {
                return None;
            }

            let id_text = id.to_string();
            let name = field_or(country, &["eng", "name", "rus"], format!("Country {id}"));
            if name.is_empty() {
                return None;
            }

            Some(json!({
                "id": id,
                "name": name,
                "dialCode": country_dial_code(&id_text)
            }))
        })
        .collect::<Vec<_>>();

    normalized.sort_by(|a, b| value_string(a, "name").cmp(&value_string(b, "name")));
    if normalized.is_empty() {
        fallback_countries()
    } else {
        normalized
    }
}

fn strip_country_code(phone_number: &str, country_id: &str) -> String {
    let digits = phone_number
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '+')
        .collect::<String>()
        .trim_start_matches('+')
        .to_string();
    let dial_code = country_dial_code(country_id);

    if !dial_code.is_empty() && digits.starts_with(dial_code) && digits.len() > dial_code.len() + 4
    {
        digits[dial_code.len()..].to_string()
    } else {
        digits
    }
}

fn parse_activation(result: &FetchResult) -> (String, String) {
    if let Some(json) = &result.json {
        let activation_id = json
            .get("activationId")
            .map(value_to_text)
            .unwrap_or_default();
        let phone_number = json
            .get("phoneNumber")
            .map(value_to_text)
            .unwrap_or_default();
        if !activation_id.is_empty() || !phone_number.is_empty() {
            return (activation_id, phone_number);
        }
    }

    let text = result.text.trim();
    if let Some(rest) = text.strip_prefix("ACCESS_NUMBER_OK:") {
        let parts = rest.split(':').collect::<Vec<_>>();
        return (
            parts.first().copied().unwrap_or_default().to_string(),
            parts.get(1).copied().unwrap_or_default().to_string(),
        );
    }

    (String::new(), String::new())
}

fn read_accounts(app: &AppHandle) -> ApiResult<Vec<Value>> {
    let path = accounts_path(app);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };

    let parsed = serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())?;
    Ok(parsed
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn write_accounts(app: &AppHandle, mut accounts: Vec<Value>) -> ApiResult<Vec<Value>> {
    accounts.sort_by(|a, b| value_string(b, "updated_at").cmp(&value_string(a, "updated_at")));
    write_json(&accounts_path(app), &json!({ "accounts": accounts }))?;
    Ok(accounts)
}

fn upsert_account(app: &AppHandle, fields: Value) -> ApiResult<Value> {
    let email = body_string(&fields, "email")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if email.is_empty() {
        return Err("Missing account email".to_string());
    }

    let mut accounts = read_accounts(app)?;
    let now = Utc::now().to_rfc3339();
    let index = accounts
        .iter()
        .position(|account| value_string(account, "email").to_lowercase() == email);
    let existing = index
        .and_then(|index| accounts.get(index).cloned())
        .unwrap_or_else(|| json!({}));

    let mut next = existing.as_object().cloned().unwrap_or_else(Map::new);
    if let Some(fields) = fields.as_object() {
        for (key, value) in fields {
            next.insert(key.clone(), value.clone());
        }
    }

    let created_at = next
        .get("created_at")
        .map(value_to_text)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| now.clone());
    next.insert("email".to_string(), json!(email));
    next.insert("created_at".to_string(), json!(created_at));
    next.insert("updated_at".to_string(), json!(now));

    let next_value = Value::Object(next);
    if let Some(index) = index {
        accounts[index] = next_value.clone();
    } else {
        accounts.insert(0, next_value.clone());
    }

    write_accounts(app, accounts)?;
    Ok(next_value)
}

fn delete_account(app: &AppHandle, email: &str) -> ApiResult<bool> {
    if email.is_empty() {
        return Err("Missing account email".to_string());
    }

    let accounts = read_accounts(app)?;
    let before = accounts.len();
    let next = accounts
        .into_iter()
        .filter(|account| value_string(account, "email").to_lowercase() != email)
        .collect::<Vec<_>>();
    let deleted = before != next.len();
    write_accounts(app, next)?;
    Ok(deleted)
}

fn nordvpn_run(args: &[&str]) -> ApiResult<(bool, String)> {
    let output = Command::new("nordvpn").args(args).output().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            "NordVPN CLI not found. Install NordVPN to use VPN controls.".to_string()
        } else {
            format!("Failed to run nordvpn: {error}")
        }
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let message = if !stdout.is_empty() { stdout } else { stderr };
    Ok((output.status.success(), message))
}

fn parse_vpn_status(text: &str) -> Value {
    let mut map = Map::new();
    let mut connected = false;

    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() {
            continue;
        }

        if key.eq_ignore_ascii_case("status") {
            connected = value.eq_ignore_ascii_case("connected");
        }

        let normalized_key = key.to_lowercase().replace(' ', "_");
        map.insert(normalized_key, json!(value));
    }

    map.insert("connected".to_string(), json!(connected));
    Value::Object(map)
}

fn vpn_status_value() -> ApiResult<Value> {
    let (ok, text) = nordvpn_run(&["status"])?;
    if !ok {
        return Err(if text.is_empty() {
            "Failed to read VPN status".to_string()
        } else {
            text
        });
    }

    let mut status = parse_vpn_status(&text);
    if let Value::Object(ref mut map) = status {
        map.insert("success".to_string(), json!(true));
    }
    Ok(status)
}

fn find_browser(preferred: &str) -> Option<Browser> {
    let chromium = [
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "brave-browser",
        "microsoft-edge",
    ];
    let firefox = ["firefox", "librewolf"];
    let candidates = match preferred {
        "chromium" => chromium.to_vec(),
        "firefox" => firefox.to_vec(),
        _ => chromium
            .iter()
            .chain(firefox.iter())
            .copied()
            .collect::<Vec<_>>(),
    };

    for command in candidates {
        let output = Command::new("sh")
            .args(["-lc", &format!("command -v {command}")])
            .output()
            .ok()?;

        if output.status.success() && !String::from_utf8_lossy(&output.stdout).trim().is_empty() {
            let kind = if firefox.contains(&command) {
                "firefox"
            } else {
                "chromium"
            };
            return Some(Browser {
                command: command.to_string(),
                kind: kind.to_string(),
            });
        }
    }

    None
}

fn random_user_agent() -> String {
    let platforms = [
        "Windows NT 10.0; Win64; x64",
        "Windows NT 10.0; WOW64",
        "Windows NT 11.0; Win64; x64",
    ];
    let versions = ["133", "134", "135", "136", "137"];
    let platform = platforms[rand::thread_rng().gen_range(0..platforms.len())];
    let version = versions[rand::thread_rng().gen_range(0..versions.len())];
    format!("Mozilla/5.0 ({platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version}.0.0.0 Safari/537.36")
}

fn random_viewport() -> (u32, u32) {
    let dimensions = [(1280, 720), (1366, 768), (1440, 900), (1536, 864), (1920, 1080)];
    dimensions[rand::thread_rng().gen_range(0..dimensions.len())]
}

fn random_position() -> (i32, i32) {
    let rng = &mut rand::thread_rng();
    (rng.gen_range(20..200), rng.gen_range(20..200))
}

fn setup_fingerprint_profile_dir() -> String {
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    format!("/tmp/wolt-profile-{timestamp}-{}", rand::thread_rng().gen_range(1000u32..9999u32))
}

fn launch_private_browser(preferred: &str) -> ApiResult<(Browser, Fingerprint)> {
    let browser = find_browser(preferred)
        .ok_or_else(|| "No supported browser found. Install Firefox or Chromium.".to_string())?;

    if browser.kind == "firefox" {
        let profile_dir = setup_fingerprint_profile_dir();
        fs::create_dir_all(&profile_dir).map_err(|error| format!("Failed to create profile dir: {error}"))?;

        let mut prefs_js = String::new();
        prefs_js.push_str("user_pref(\"privacy.fingerprintingProtection\", true);\n");
        prefs_js.push_str("user_pref(\"privacy.resistFingerprinting\", true);\n");
        prefs_js.push_str("user_pref(\"privacy.trackingprotection.fingerprinting.enabled\", true);\n");
        prefs_js.push_str("user_pref(\"media.peerconnection.enabled\", false);\n");
        prefs_js.push_str("user_pref(\"media.navigator.enabled\", false);\n");
        prefs_js.push_str("user_pref(\"dom.webnotifications.enabled\", false);\n");
        prefs_js.push_str("user_pref(\"geo.enabled\", false);\n");
        prefs_js.push_str("user_pref(\"browser.shell.checkDefaultBrowser\", false);\n");
        prefs_js.push_str("user_pref(\"datareporting.healthreport.uploadEnabled\", false);\n");
        prefs_js.push_str("user_pref(\"toolkit.telemetry.reportingpolicy.firstRun\", false);\n");
        prefs_js.push_str("user_pref(\"browser.newtabpage.activity-stream.feeds.telemetry\", false);\n");
        prefs_js.push_str("user_pref(\"browser.newtabpage.activity-stream.telemetry\", false);\n");
        prefs_js.push_str("user_pref(\"devtools.onboarding.telemetry.logged\", false);\n");
        prefs_js.push_str("user_pref(\"app.normandy.enabled\", false);\n");
        prefs_js.push_str("user_pref(\"app.shield.optoutstudies.enabled\", false);\n");
        prefs_js.push_str("user_pref(\"canvas.capturestream.enabled\", false);\n");
        prefs_js.push_str("user_pref(\"webgl.disabled\", true);\n");
        prefs_js.push_str("user_pref(\"dom.battery.enabled\", false);\n");
        prefs_js.push_str("user_pref(\"network.http.referer.XOriginPolicy\", 1);\n");

        fs::write(format!("{profile_dir}/user.js"), prefs_js)
            .map_err(|error| format!("Failed to write Firefox prefs: {error}"))?;

        let (width, height) = random_viewport();
        let (pos_x, pos_y) = random_position();

        Command::new(&browser.command)
            .args([
                "--profile", &profile_dir,
                "--new-window", WOLT_URL,
                "--window-size", &format!("{width},{height}"),
                "--window-position", &format!("{pos_x},{pos_y}"),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Failed to launch Firefox: {error}"))?;

        let fp = Fingerprint {
            user_agent: String::new(),
            profile_dir,
            width,
            height,
            pos_x,
            pos_y,
            lang: "en-US".to_string(),
            gl_renderer: "WebGL disabled".to_string(),
            webrtc_policy: "disabled".to_string(),
            canvas_blocked: true,
            features_disabled: vec![
                "fingerprintingProtection".to_string(),
                "resistFingerprinting".to_string(),
                "peerconnection".to_string(),
                "webgl".to_string(),
                "canvas.capturestream".to_string(),
                "battery".to_string(),
            ],
        };
        return Ok((browser, fp));
    }

    let profile_dir = setup_fingerprint_profile_dir();
    fs::create_dir_all(&profile_dir).map_err(|error| format!("Failed to create profile dir: {error}"))?;

    let user_agent = random_user_agent();
    let (width, height) = random_viewport();
    let (pos_x, pos_y) = random_position();
    let lang = "en-US";

    let features_disabled = vec![
        "sync".to_string(),
        "background-networking".to_string(),
        "breakpad".to_string(),
        "client-side-phishing-detection".to_string(),
        "component-update".to_string(),
        "default-apps".to_string(),
        "hang-monitor".to_string(),
        "popup-blocking".to_string(),
        "renderer-backgrounding".to_string(),
    ];

    let args = vec![
        format!("--user-data-dir={profile_dir}"),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-sync".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-background-timer-throttling".to_string(),
        "--disable-backgrounding-occluded-windows".to_string(),
        "--disable-breakpad".to_string(),
        "--disable-client-side-phishing-detection".to_string(),
        "--disable-component-update".to_string(),
        "--disable-default-apps".to_string(),
        "--disable-hang-monitor".to_string(),
        "--disable-popup-blocking".to_string(),
        "--disable-prompt-on-repost".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-session-crashed-bubble".to_string(),
        format!("--user-agent={user_agent}"),
        format!("--lang={lang}"),
        format!("--window-size={width},{height}"),
        format!("--window-position={pos_x},{pos_y}"),
        WOLT_URL.to_string(),
    ];

    Command::new(&browser.command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to launch Chromium: {error}"))?;

    let fp = Fingerprint {
        user_agent,
        profile_dir,
        width,
        height,
        pos_x,
        pos_y,
        lang: lang.to_string(),
        gl_renderer: "default".to_string(),
        webrtc_policy: "default".to_string(),
        canvas_blocked: false,
        features_disabled,
    };

    Ok((browser, fp))
}
