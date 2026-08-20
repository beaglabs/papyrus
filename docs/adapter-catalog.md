# Adapter catalog

Papyrus launches runtimes only through compiled catalog profiles. The initial
catalog contains Goose (`goose acp`) and OpenCode (`opencode acp`). Configuration
may assign a local alias to one of those profiles, but cannot supply a command,
arguments, shell fragments, or inline secrets.

Environment bindings name a `PAPYRUS_SECRET_*` variable. Papyrus resolves the
value in memory when configuration loads:

```yaml
agents:
  reviewer:
    profile: opencode
    environment:
      OPENAI_API_KEY: PAPYRUS_SECRET_OPENAI
```

Chrome ACP is an optional connector profile. Its browser operations map to
separate Cedar actions for navigation, reading, script execution, downloads,
uploads, credential use, and submissions. Enabling the profile does not bypass
workspace assignment, tool grants, session ownership, or Papyrus audit events.

Papyrus treats catalog metadata as data. It never interpolates a manifest into
a shell command.
