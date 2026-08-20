# External ACP connector

`papyrus-connect` lets an ACP client that supports only spawning a local stdio
agent connect to the remote Papyrus daemon. It translates newline-delimited ACP
frames on stdin/stdout to the official Streamable HTTP transport without
changing requests, responses, notifications, session IDs, or method names.

Configure the client to spawn:

```text
papyrus-connect --url https://papyrus.example/acp --workspace <workspace-id>
```

Provide authentication outside the command line:

- `PAPYRUS_CONNECT_TOKEN` contains a revocable Papyrus bearer session; or
- `PAPYRUS_CONNECT_TOKEN_FILE` points to a file containing that session.

The workspace may instead be supplied with `PAPYRUS_CONNECT_WORKSPACE`. Tokens
are deliberately unsupported as command-line flags or URL query parameters so
they do not appear in process listings, shell history, or proxy logs.

The bridge does not accept a runtime identifier. Clients always connect to the
single `/acp` endpoint. Papyrus selects the runtime from the authenticated
workspace/session policy and continues to mediate model access, MCP discovery,
tool authorization, cancellation, and audit events.

`GOOSE_SERVER__SECRET_KEY` is not read by the connector or daemon boundary.
