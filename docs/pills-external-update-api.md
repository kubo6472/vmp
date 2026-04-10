# Pills External Update API

Endpoint: `POST /api/pills/update`

## Auth

- Required header: `x-api-key: <key>`
- Active key source priority:
  1. `PILLS_API_KEY` environment secret
  2. `admin_settings.pills_api_key`

Failed auth returns:

`401`

`{ "error": "Unauthorized", "code": "invalid_api_key" }`

## Request payload

`Content-Type: application/json`

```json
{
  "pills": [
    {
      "id": "subscribers",
      "label": "Subscribers",
      "value": 1842,
      "color": "#2563eb",
      "sortOrder": 0
    }
  ]
}
```

## Success response

`200`

```json
{
  "ok": true,
  "updated": 1
}
```

## Rate limit

- Dedicated limiter for this endpoint (KV-backed).
- Keyed by API key prefix + client IP.
- Configurable setting: `admin_settings.pills_update_rate_limit_per_minute`
- Default: `30` requests/minute.

When exceeded:

- Status: `429`
- Includes `Retry-After` response header.
- Body:

```json
{
  "error": "Too many pills update requests",
  "code": "rate_limited"
}
```

## Public read endpoint

Use `GET /api/pills` to retrieve the ordered pills currently displayed on homepage.

Response shape:

```json
{
  "pills": [
    {
      "id": "subscribers",
      "label": "Subscribers",
      "value": 1842,
      "color": "#2563eb",
      "sort_order": 0,
      "updated_at": "2026-04-10 00:00:00"
    }
  ]
}
```
