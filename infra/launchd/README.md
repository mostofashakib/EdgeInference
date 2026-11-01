# macOS launchd Background Service Management

## Overview
EdgeInference utilizes macOS `launchd` for process supervision, automatic restart on crash, and bounded throttling without duplicate background managers.

## Service Labels
- `com.edgeinference.gateway` (Fastify Inference Gateway on port 8765)
- `com.edgeinference.nginx` (Nginx Reverse Proxy on port 8080)

## Installation & Activation

1. Build the gateway TypeScript project:
   ```bash
   pnpm build
   ```
2. Copy plists to user LaunchAgents (substituting your project path):
   ```bash
   sed "s|/path/to/EdgeInference|$(pwd)|g" infra/launchd/com.edgeinference.gateway.plist > ~/Library/LaunchAgents/com.edgeinference.gateway.plist
   sed "s|/path/to/EdgeInference|$(pwd)|g" infra/launchd/com.edgeinference.nginx.plist > ~/Library/LaunchAgents/com.edgeinference.nginx.plist
   ```
3. Load the services:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.edgeinference.gateway.plist
   launchctl load ~/Library/LaunchAgents/com.edgeinference.nginx.plist
   ```
4. Check running status:
   ```bash
   launchctl list | grep edgeinference
   ```

## Unloading & Disabling

```bash
launchctl unload ~/Library/LaunchAgents/com.edgeinference.gateway.plist
launchctl unload ~/Library/LaunchAgents/com.edgeinference.nginx.plist
```

