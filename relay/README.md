# Durable UniFi relay

`relay.mjs` accepts UniFi webhook events, normalizes a deterministic event ID,
writes each matching route to a mode-0600 spool file, and only then returns
`202`. Target failures remain in the spool and retry with bounded exponential
backoff. `/health` reports queue depth.

Configuration supports event, alarm, camera, and negative event-type matches.
Set `secretsFile` to a mode-0600 JSON document and use SecretRef objects such as
`{"source":"file","provider":"secrets","id":"/unifi/relayToken"}`. Environment
interpolation remains available for non-secret deployment paths, but secrets
should have one canonical source per host. Keep real endpoints, camera IDs, and
tokens in private deployment configuration.

The included launchd file is an installation example. Copy it and
`example.config.json` to private paths, adjust ownership and permissions, then
validate with synthetic events before enabling a live UniFi webhook.
