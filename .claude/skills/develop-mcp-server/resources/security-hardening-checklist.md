# Security Hardening Checklist

## Purpose

Security requirements for MCP server including systemd hardening, rate limiting, secret management, and input validation.

## Systemd Security Hardening

Required systemd service restrictions:
- NoNewPrivileges=true
- PrivateTmp=true
- ProtectSystem=strict
- ProtectHome=true
- ProtectKernelTunables=true
- RestrictRealtime=true
- LockPersonality=true
- RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
- SystemCallFilter=@system-service
- Resource limits: CPUQuota, MemoryMax, LimitNOFILE

## Secret Management

No hardcoded secrets, all secrets in .env, .env never committed (.gitignore), .env.example with placeholders only, config validation rejects placeholder values

## Rate Limiting

Configurable rate limiting for external API calls, prevents API abuse, respects API provider limits

## Input Validation

All external inputs validated with pydantic, no SQL injection (use parameterized queries), no command injection (avoid shell=True), sanitize file paths
