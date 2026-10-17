# Security policy

## Reporting a vulnerability

**Please do not report security issues in public issues, pull requests or on Discord.**

Report them privately through GitHub: open the [**Security** tab of this repository](https://github.com/purosapp/purosapp/security) and choose **Report a vulnerability** ([direct link](https://github.com/purosapp/purosapp/security/advisories/new)). Only the maintainers can see the report.

Please include:

- the Puros version (the release you downloaded, or **Finder → Get Info** on Puros.app) and your macOS version and Mac model
- what an attacker can do, and what they need first (a malicious file, a malicious provider package, a network position, local access…)
- steps to reproduce, ideally with a proof of concept
- any provider involved, with its ID and version

## What to expect

Puros is maintained by a small team, so these are goals, not guarantees:

- an acknowledgement within **3 days**
- a first assessment within **10 days**, telling you whether we consider it a vulnerability and how serious it is
- a fix in the next release for confirmed issues, sooner for serious ones

We will keep you updated in the advisory, agree with you on when details go public, and credit you in the advisory and the release notes unless you prefer otherwise. Please give us a reasonable amount of time to ship a fix before disclosing it yourself.

## Supported versions

Puros is in alpha. Only the **latest release** on the [Releases](https://github.com/purosapp/purosapp/releases) page receives security fixes; please check that an issue still reproduces there.

## Scope

This policy covers the Puros app in this repository. Examples of what we want to hear about:

- a crafted audio file, playlist, artwork or metadata that leads to code execution, memory corruption in the native audio engine, or reading or writing files outside what Puros should touch
- the renderer, a web page or a sign-in window reaching Node.js, the file system or IPC it should not have
- bypassing provider package verification: installing a tampered package, a publisher key change that does not warn, or a package escaping its declared install location
- leaking stored provider credentials or session cookies to another provider, a web page or logs
- weaknesses in how the signed macOS builds are produced or distributed

### Other projects

- **Provider SDK:** report to [purosapp/puros-provider-sdk](https://github.com/purosapp/puros-provider-sdk/security).
- **Providers** (SoundCloud, Spotify, TIDAL, YouTube Music and others listed in [providers-list](https://github.com/purosapp/providers-list)) are third-party software published by their authors. Report issues to that provider's repository. If a provider can break out of the isolation that Puros promises, that part is a Puros issue and belongs here.
- **Upstream dependencies** (Electron, FFmpeg, libsoxr and others): report to the upstream project. Tell us too if Puros ships an affected version.

### Not vulnerabilities

- **Providers run with your privileges.** Each provider runs in its own Electron `utilityProcess`, but that is not an OS sandbox: provider code can use the file system, start processes and reach the network. The install screen says so. Only install providers you trust. A provider that misuses these documented abilities is not a Puros vulnerability.
- Credentials compiled into the app for public APIs (for example the Last.fm API key or the Discord application ID). Desktop apps cannot keep these secret.
- Issues that need an already compromised Mac, physical access to an unlocked machine, or a user deliberately disabling macOS protections.
- Reports produced only by automated scanners, without a demonstrated impact on Puros.

## Safe harbour

We will not take legal action against research done in good faith under this policy. That means: only test your own accounts, devices and installations; do not access other people's data; and do not degrade services for others, including the streaming services that providers talk to.
