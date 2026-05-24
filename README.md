# Woltmanual

Local manual Wolt helper.

Run the desktop app in development:

```bash
npm start
```

Run the legacy web server:

```bash
npm run web
```

Build the desktop app:

```bash
npm run build
```

The app reads `config.json` from the project root. Use `default_email_provider` to choose which email provider is selected when the app starts. The visual provider switch in the Email step updates this value and saves it back to `config.json`.

Example:

```json
{
  "sms_api_key": "your-hero-sms-key",
  "default_email_provider": "testmail",
  "email_provider": "testmail",
  "testmail_api_key": "your-testmail-key",
  "testmail_namespace": "your-testmail-namespace",
  "tempmail_api_key": "your-rapidapi-key",
  "tempmail_domain": ""
}
```

Set `default_email_provider` to either `testmail` or `tempmail`. `email_provider` is kept for compatibility and should usually match `default_email_provider`. `tempmail_domain` is optional; when empty the app asks the Temp Mail API for an available domain.

| Key | Description |
| --- | --- |
| `sms_api_key` | Hero SMS API key used for phone number and SMS code requests. |
| `default_email_provider` | Startup email provider. Use `testmail` or `tempmail`. |
| `email_provider` | Compatibility value; keep it matching `default_email_provider`. |
| `testmail_api_key` | Testmail API key used for reading inbox messages. |
| `testmail_namespace` | Testmail namespace used to generate inbox addresses. |
| `tempmail_api_key` | RapidAPI key for Temp Mail. |
| `tempmail_domain` | Optional Temp Mail domain. Leave empty to auto-select one. |

Generated accounts are stored in `accounts.json`.

The Wolt button launches a private Firefox or Chromium window when either browser is installed.
