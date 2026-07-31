# Pi agent configuration

Personal global configuration for [Pi](https://github.com/badlogic/pi-mono): custom extensions, themes, and settings. It intentionally excludes credentials, conversation history, trust decisions, runtime binaries, and installed npm packages.

## Bootstrap a new system

### Prerequisites

Install Pi, Git, and Node/npm.

### Clone the configuration

> **Warning:** This replaces `~/.pi/agent`. Back up an existing installation first if it contains extensions, themes, settings, or sessions you want to retain.

```bash
mv ~/.pi/agent ~/.pi/agent.backup-$(date +%Y%m%d-%H%M%S)  # omit when no existing directory
mkdir -p ~/.pi
git clone git@github.com:npho/pi-agent.git ~/.pi/agent
cd ~/.pi/agent
```

### Install managed packages and authenticate

The `npm/` directory is intentionally not versioned. Install the MCP adapter specified in `settings.json`:

```bash
pi install npm:pi-mcp-adapter
```

Then start Pi and authenticate the providers you use:

```bash
cd ~
pi
```

Pi will create local-only files such as `auth.json`, `trust.json`, `sessions/`, `models-store.json`, and `npm/`. They are deliberately ignored by Git.

## Updating

Pull customizations, then update unpinned Pi packages when desired:

```bash
cd ~/.pi/agent
git pull --ff-only
pi update --extensions
```

Review changes before restarting Pi. Extensions run with your full user permissions, so only pull/install sources you trust.

## What is tracked

- `extensions/` — custom UI, status, tmux, and response-rendering extensions
- `themes/` — custom Pi themes
- `settings.json` — global Pi settings and package sources

## What is not tracked

Credentials (`auth.json`), sessions, trust decisions, crash logs, runtime binaries, package installs, and generated model metadata remain local to each machine.
