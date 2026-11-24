# Chromium sandbox policy

The API visits untrusted public pages during onboarding screenshots. It runs as
UID 1001 and keeps Chromium's namespace and seccomp sandboxes enabled.
Docker's default syscall policy blocks the namespace creation required by that
browser sandbox, so the API in each Compose stack uses `chromium-seccomp.json`.
The API runtime uses Debian Bookworm rather than Alpine: the deployed Alpine
3.24/musl 1.2.6 combination crashes inside Chromium's GPU sandbox on `pwritev2`.
The glibc runtime keeps that sandbox enabled. The worker runtime is unchanged.

This policy is Moby's default seccomp profile from commit
`6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef`, with one additional allow rule for
`clone`, `setns`, and `unshare`, as documented by
[Playwright](https://playwright.dev/docs/docker#crawling-and-scraping).
All other upstream rules are preserved, including the denial of `io_uring_*`.
Neither `SYS_ADMIN`, privileged mode, nor an unconfined seccomp profile is needed.

Upstream source:
<https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json>

The original file's SHA-256 is
`6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`.
Moby's Apache 2.0 license is included in `moby-profiles-LICENSE`.
The added rule contains a modification notice.

Before rollout, run the isolated Linux check against the exact API image:

```sh
bash scripts/check-chromium-sandbox.sh <api-image-id>
```

The check launches a disposable, non-root container with no external network,
limited resources, and this profile. It verifies browser sandbox state, produces
a PNG in memory, and proves that the dead-proxy backstop blocks a loopback HTTP
request. It does not mount application data or connect to providers/databases.
It imports the same browser launcher built into the API image; the operations
safety workflow also runs this check against a freshly built API image.
Keep the profile with the Compose file on the Docker client host; Docker reads
the policy there. Recheck it when changing Docker, Chromium, or the host kernel.
