# openclaw-zulip
OpenClaw Zulip channel plugin — extracted from jamie-dit/zulip-claw.

## Install
```bash
openclaw plugins install /path/to/openclaw-zulip
```

## Upstream sync
```bash
git fetch upstream
git subtree pull --prefix=. upstream main --squash -- extensions/zulip
```
