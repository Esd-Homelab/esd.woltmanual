# esd.woltmanual

Local manual Wolt helper.

```bash
npm start
```

The app reads `config.json` from the project root. Create it with this structure:

```json
{
  "sms_api_key": "your-hero-sms-api-key",
  "testmail_api_key": "your-testmail-api-key",
  "testmail_namespace": "your-testmail-namespace"
}
```

| Key | Description |
| --- | --- |
| `sms_api_key` | Hero SMS API key used for phone number and SMS code requests. |
| `testmail_api_key` | Testmail API key used for reading inbox messages. |
| `testmail_namespace` | Testmail namespace used to generate inbox addresses. |

Generated accounts are stored in `accounts.json`.

The Wolt button launches a private Firefox or Chromium window when either browser is installed.
