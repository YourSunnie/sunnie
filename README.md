# Sunnie

A personal AI assistant that does your online tasks. Ask it on your iPhone, it works in the
background, and it messages you when it is done.

One Sunnie serves one person. It has its own computer, remembers you over time, and runs on the
AI model you choose. Don't want to run a server? Hosted Sunnie is at [yoursunnie.com](https://yoursunnie.com).

## What it does

- **Does the legwork.** Searches the web, browses sites in a real Chrome, compares prices and fills in forms.
- **Asks first.** Before it books, sends, pays or deletes anything, you get the exact action to Allow or Deny.
- **Has its own computer.** A shell, files and a Drive you share with it. It can install the tools it needs.
- **Remembers you.** Long-term memory that it keeps up to date as it learns about you.
- **Keeps your logins safe.** It signs in for you without ever seeing your passwords.
- **Follows up.** Reminders and things to watch, checked in the background.
- **Works with any model.** OpenRouter, Anthropic, OpenAI, Google, DeepSeek, xAI, or any
  OpenAI-compatible server such as Ollama.

## Run it yourself

You need an Ubuntu server (22.04, 24.04 or 26.04 LTS) and an OpenRouter API key (other providers
can be set up afterwards).
Clone the repository as a dedicated user, then run one installer:

```bash
sudo adduser sunnie
sudo -iu sunnie git clone https://github.com/YourSunnie/sunnie.git Sunnie

sudo bash /home/sunnie/Sunnie/install-docker.sh                  # in Docker
sudo bash /home/sunnie/Sunnie/install-native.sh --user sunnie     # or directly on the server
```

Sunnie listens on `http://127.0.0.1:8787`. Put an HTTPS tunnel in front of it, then enter the
tunnel's address and the app key in the iPhone app. The installer prints where to find the key.

To update, pull the repository and run the same installer again. Your data is kept.

## The iPhone app

Open `app/Sunnie/Sunnie.xcodeproj` in Xcode 27 (iOS 26 or later). The simulator needs no Apple
account. For your own device, copy `app/Sunnie/Signing.local.example.xcconfig` to
`Signing.local.xcconfig` and set your team ID.

## Development

```bash
cd api
pnpm install
cp .env.example .env    # set SUNNIE_API_KEY and a provider key
pnpm dev                # server on localhost:8787
pnpm check              # type check and tests
```

`api/` is the server (TypeScript, Node 24), `app/` the iPhone and Mac app (SwiftUI).

## License

Source available under the [Functional Source License 1.1, ALv2 Future License](LICENSE.md):
use, change and run it for yourself or your organisation for free, but not as a competing
commercial service. Each version becomes Apache-2.0 two years after release. The Sunnie name
and logo are not covered; see [NOTICE.md](NOTICE.md).
