# MeshCore Wardrive Map

Live web map for displaying MeshCore wardrive data collected from the Android app.
Hosted at **https://wardrive.inwmesh.org**

## Features

- Dark/light theme map (CartoDB / OpenStreetMap tiles)
- Real-time coverage display with geohash grid squares
- Statistics panel (total samples, unique nodes)
- Auto-refresh every 30 seconds
- Heatmap layer and repeater marker overlays
- Time-lapse playback of historical coverage
- Distance measure tool

## Self-Hosting

See [SELF_HOSTING.md](SELF_HOSTING.md) for full Docker deployment instructions
(Node.js + PostgreSQL + Redis).

## API Endpoints

### GET `/api/samples`
Returns the shard index with coverage metadata.

### GET `/api/samples?prefixes=xyz,abc`
Returns coverage cell data for the specified geohash shard prefixes.

### POST `/api/samples/:token`
Upload new samples. Requires a valid contributor token in the URL path.

```json
{
  "samples": [
    {
      "nodeId": "ABC123",
      "latitude": 47.6588,
      "longitude": -117.4260,
      "rssi": -95,
      "snr": 8,
      "pingSuccess": true,
      "timestamp": "2026-01-06T00:00:00Z",
      "appVersion": "1.0.25"
    }
  ]
}
```

### GET `/api/samples/:token/validate`
Check whether a contributor token is valid. Returns `{ valid: true }` or `{ valid: false, error: "..." }`.
Rate limited to 10 requests/IP/minute.

### GET `/api/contributions/:token`
Returns the geohash cells contributed by this token (used for "my data" map filter).

### DELETE `/api/samples`
Wipe all data. Requires `Authorization: Bearer <ADMIN_TOKEN>` header.

## Android App

The companion Android app is at:
https://github.com/george-viaud/Meshcore-Wardrive-Android

Contributors need an invite from an admin — registration is at `/invite/:code`.
Once registered, the Contributor Token is entered in the app's **Settings → Configure API**.

## Credits

Originally inspired by mesh-map.pages.dev by Kyle Reed for MeshCore coverage mapping.

## License

GNU General Public License v3.0
