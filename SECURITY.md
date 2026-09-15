# Security

The command interface binds only to IPv4 loopback (`127.0.0.1`). It has no authentication: any local process can send commands, navigate the web view and request media within the configured root. Do not expose or forward these ports to other machines.

Web content is isolated from the local renderer's Node bridge. Local media access is constrained to `mediaRoot`; the exact configured Empty image is allowed separately. Keep Electron updated when maintaining a deployment.

Browser data and logs remain in the configured data directory. Cache clearing retains cookies and page storage. Diagnostics may contain paths and URLs. Do not upload profiles or unredacted private data in issues.

Only the current development version is maintained; there is no guaranteed security response time. If GitHub private vulnerability reporting is enabled, use its Security tab. Otherwise ask the maintainer for a private reporting channel without posting exploit details or sensitive data publicly.
