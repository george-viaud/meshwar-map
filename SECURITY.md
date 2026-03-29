# Security Configuration

## DELETE Endpoint Protection

The `/api/samples` DELETE endpoint is protected with a Bearer token to prevent unauthorized data deletion.

### Setup

The `ADMIN_TOKEN` is set as a system environment variable on the host server (see [SELF_HOSTING.md](SELF_HOSTING.md)).

### Using the DELETE Endpoint

**Without token (blocked):**
```bash
curl -X DELETE https://wardrive.inwmesh.org/api/samples
```
Response: `{"error":"Unauthorized"}`

**With valid token:**
```bash
curl -X DELETE https://wardrive.inwmesh.org/api/samples \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN_HERE"
```
Response: `{"success":true,"message":"All data cleared"}`

## Important Notes

- The GET and POST endpoints are public — anyone can view or upload data
- Only DELETE requires authentication
- Never commit or share your admin token
- If the token is compromised, update `ADMIN_TOKEN` in `/etc/environment` on the server and restart the containers
