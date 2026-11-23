# Remote SMS Campaign Management Portal

Multi-company Node.js / Express backend + Tailwind admin dashboard that queues SMS jobs for Android SMS Gateway apps. **Each company's data is fully isolated.**

## How multi-company works

1. **Master Admin** logs in with `MASTER_ADMIN_TOKEN` and creates companies (each must include at least one user).
2. Every company gets its own **API token**.
3. Company staff / Android gateway use **that company's token** only.
4. Campaigns, message jobs, devices, and users never cross between companies.

```
Master Admin  →  creates Company A + Company B
Company A token  →  only A's campaigns / jobs / gateways
Company B token  →  only B's campaigns / jobs / gateways
```

## Stack

- **Backend:** Node.js 22.5+ (built-in `node:sqlite`), Express
- **Frontend:** HTML + Tailwind CSS (CDN) + Vanilla JS
- **Auth:** Bearer tokens (company token or master token)

## Quick start

```bash
node -v          # need v22.5+
npm install
copy .env.example .env
# Set MASTER_ADMIN_TOKEN (and optionally ADMIN_API_TOKEN for Default Company seed)
npm start
```

Open **http://localhost:3000** and sign in with **username + password**.

| Who | Username | Password | What you can do |
|---|---|---|---|
| **Master Admin** | `MASTER_ADMIN_USERNAME` (default `master`) | `MASTER_ADMIN_PASSWORD` | List companies; click **Create Company** to add one |
| **Company users** | set when creating the company | set when creating the company | That company's dashboard only |

No sample companies are created automatically. Android gateway uses the **company API token** (shown after create / under Users), not the password.

## Environment variables

| Variable | Description |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `MASTER_ADMIN_USERNAME` | Master login username (default `master`) |
| `MASTER_ADMIN_PASSWORD` | Master login password |
| `MASTER_ADMIN_TOKEN` | Internal token issued after master login |
| `JOB_BATCH_SIZE` | Jobs returned per pull (default `10`, max `50`) |

## Gateway API (Android — unchanged paths)

Use the **company** API token (not the master token):

```
Authorization: Bearer <COMPANY_API_TOKEN>
```

### Register

`POST /api/gateway/register`

```json
{ "deviceIdentifier": "android-unique-id", "deviceName": "Galaxy A14", "androidVersion": "14", "appVersion": "1.2.0" }
```

→ `{ "success": true, "message": "Registered", "gatewayId": "gw_..." }`

### Pull jobs (this company only)

`GET /api/gateway/jobs?deviceIdentifier=android-unique-id`

### Status / batch-sync

`POST /api/gateway/status`  
`POST /api/gateway/batch-sync`

Allowed statuses: `QUEUED`, `PROCESSING`, `SENT`, `DELIVERED`, `SEND_FAILED`, `DELIVERY_FAILED`

## Master API

```
Authorization: Bearer <MASTER_ADMIN_TOKEN>
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/master/companies` | List companies (+ users dict) |
| POST | `/api/master/companies` | Create company (users required) |
| GET | `/api/master/companies/:id` | Get one company |
| POST | `/api/master/companies/:id/regenerate-token` | New API token |
| DELETE | `/api/master/companies/:id` | Delete company + all its data |

### Create company body

```json
{
  "name": "Acme Logistics",
  "users": [
    { "name": "Jane Doe", "email": "jane@acme.com", "role": "admin" },
    { "name": "John Smith", "email": "john@acme.com", "role": "member" }
  ]
}
```

Response includes `company.apiToken` and `company.users` as a **dictionary keyed by user id**.

## Company Admin API

```
Authorization: Bearer <COMPANY_API_TOKEN>
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/me` | Company profile + users dict |
| GET | `/api/admin/stats` | Overview counts (scoped) |
| GET/POST | `/api/admin/campaigns` | List / create campaigns |
| GET | `/api/admin/messages` | Live message monitor |
| GET | `/api/admin/devices` | Gateways for this company |

## Project structure

```
├── server.js
├── public/                 # Dashboard (Company + Master modes)
├── src/
│   ├── db/database.js      # Company / User / Device / Campaign / MessageJob
│   ├── middleware/auth.js  # companyAuth + masterAuth
│   ├── routes/gateway.js
│   ├── routes/admin.js
│   └── routes/master.js
└── data/sms_portal.db
```

## Notes

- Give each Android app the **company** token for the business it serves
- Regenerating a token disconnects old apps until they are updated
- Deleting a company removes its campaigns, jobs, devices, and users
