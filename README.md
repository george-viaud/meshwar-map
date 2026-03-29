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

### POST `/api/samples`
Upload new samples from the Android app.

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
      "appVersion": "1.0.24"
    }
  ]
}
```

### DELETE `/api/samples`
Wipe all data. Requires `Authorization: Bearer <ADMIN_TOKEN>` header.

## Android App

The companion Android app is at:
https://github.com/george-viaud/Meshcore-Wardrive-Android

Upload endpoint: `https://wardrive.inwmesh.org/api/samples`

## Credits

Originally inspired by mesh-map.pages.dev by Kyle Reed for MeshCore coverage mapping.

## License

GNU General Public License v3.0
