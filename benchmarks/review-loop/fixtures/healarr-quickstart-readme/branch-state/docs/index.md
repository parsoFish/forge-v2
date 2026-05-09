# healarr — REST surface

## Endpoints

- `POST /readings` — submit a reading. Body: `{ tag: string, systolic?: number, diastolic?: number, heart_rate?: number, spo2?: number, recorded_at?: iso8601 }`.
- `GET /readings?tag=<name>` — list captured readings for a tag.
- `GET /summary?date=<iso>` — daily roll-up.

All endpoints require `Authorization: Bearer <token>`.
