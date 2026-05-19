# esd.woltmanual

Local manual Wolt helper.

```bash
npm start
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

Generated accounts are stored in `accounts.json`.

The Wolt button launches a private Firefox or Chromium window when either browser is installed.
