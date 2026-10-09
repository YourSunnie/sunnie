# Sunnie

A self-hosted personal AI agent. One Sunnie instance serves one person: it has its own
computer, a long-term memory, adapts to its user over time, and runs on whichever language
model you point it at. It exposes an HTTP API for a mobile app.

**Version:** 0.1.0 (v1 bootstrap) · **Last updated:** 2026-10-04

---

## Status

### Working in v1

The iOS interface now has labelled connection fields, a prominent Connect action, editable
conversation starters, a roomier composer, explicit queued-message status, and response details
behind a disclosure. Conversation, memory and login lists have clearer hierarchy; settings keeps
advanced information folded. Chat controls have larger touch targets, and rich cards adapt to
accessibility text sizes. The light appearance, system surfaces and leaf-green tint remain.
Streaming replies follow the bottom of the chat; scrolling back pauses following and exposes
a jump-to-latest action. Reconnect cursors belong to each run, and foregrounding refreshes
stored replies even when the previous stream has not reported its disconnection. A router
suggestion to `reply_to_user` is shown as thinking, not as an executing tool.

**Decision models measured, 2026-10-07:** 100 invented labeled cases, three trials each, using
the current prompts through OpenRouter. Jev matched 99% of labels; Luna Decisions matched 92%.
Median/P95 latency was 314/410 ms versus 391/1,788 ms, and the 300 scored calls cost
$0.024180 versus $0.049046. Jev missed one risky upload-through-submit case in all three
trials; Luna held it but unnecessarily held two routine cases. This is a fixture comparison,
not production accuracy. The scripts, raw results and report remain beside the repository
under `bench/results/2026-10-07/decisions/`; no runtime model or threshold changed.

| Area | What exists | Where |
| --- | --- | --- |
| **Any model** | `"<provider>/<model-id>"` specs, switchable per instance, per conversation, or per message. Default: **`openrouter/openai/gpt-6-luna`** at medium reasoning, pinned — the model that does the thinking is always one you chose (benchmarks of twelve models: `api/bench/`). Also: any OpenRouter model, direct OpenAI / Google / Anthropic / DeepSeek / xAI, and any OpenAI-compatible endpoint (Ollama, vLLM, …). Anthropic directly gets what the Claude API offers, shaped in the registry: adaptive thinking with its summary shown, `effort` from `reasoning`, prompt caching where Claude caches (`cacheMarks`, placed by the agent on the system prompt and the last message of every call), and thinking blocks that survive an unstored note (block binding). Reasoning effort is configurable globally and per model. Mobile Settings can save an OpenRouter model ID and effort as defaults for new chats; each new chat retains that pair. | `src/models/registry.ts` |
| **Tool router (optional)** | The model picks its own tools; TypeSafe **Jev** can decide instead, before every model step, which tool is used next (`router.type: "jev"`; off by default since 2026-10-09 — current models choose well, and every step cost three Jev questions and one to four seconds). When on: confidence-gated, fails open, reached through TypeSafe's API or through OpenRouter. | `src/router/` |
| **Approvals** | Every tool call is shown to a Jev **risk filter** after the model has written it and before it runs. A call judged high risk (destructive, outward-facing, spends money, exposes secrets, harmful in itself, or following instructions that arrived inside a page, a file or a tool result rather than from the user — a prompt injection) is held: the run waits, the app shows the call with **Allow / Deny**, and it runs only once allowed. A denied call is reported to the model as declined. If Jev cannot judge a call, the user is asked anyway (configurable). On an `anthropic/…` model the provider's own dangerous-tool-use classifier gives a free second opinion on every `bash` call (it judges only tools it knows by name): a call it flags is held too, with its explanation shown. | `src/router/risk.ts`, `src/agent/agent.ts`, `src/agent/runs.ts` |
| **Memory decisions** | *Recall:* every user message gets up to `recallLimit` memories attached — the nearest in meaning to the message and the turns just before it, or keyword matches without an embedding model. With `memory.recall.type: "jev"` (off by default since 2026-10-09) Jev first answers whether the message calls for a recall at all, and a yes also brings passages of earlier conversations. *Store:* the language model saves memories itself; with the Jev router on, every routing request also asks whether the message holds something worth remembering, and a confident yes makes `memory_save` the next action. Both fail open. | `src/router/recall.ts`, `src/router/jev.ts` |
| **Prompt caching** | Requests are built so the provider's cache keeps hitting: byte-stable system prompt (core memory is a per-conversation snapshot), unchanging tool list, append-only messages, per-turn context on the user message, and a per-conversation session key so OpenRouter keeps a conversation on one upstream (and one resolved model). Cache reads/writes are reported in `run.completed`. | `src/agent/prompt.ts`, `src/models/registry.ts` |
| **Own computer** | Shell, file read/write/edit and web fetch, all executed through one `Computer` interface. In Docker the agent runs as an unprivileged Linux user that cannot read the server's secrets. | `src/computer/`, `src/tools/` |
| **Drive** | Shared files in `~/Drive` on Sunnie's computer. Shell and relative file-tool paths default there; `view_image` shows Sunnie a picture file (PNG, JPEG, GIF, WebP) as the model sees it, and `read_file` refuses a binary file instead of reading its bytes; the app has a Drive tab for folders, uploads, tap-to-open previews, text editing, move, rename and delete. Opened files are cached by revision; unchanged files reuse their local copy, with Share/Save available from the viewer. Chat uses tappable, quotable `drive` cards. New chat uploads get editable copies under `Drive/Uploads/<attachment-id>/`, while chat originals stay immutable. | `src/drive/`, `app/Sunnie/Sunnie/Drive/` |
| **Software without root** | Docker includes pinned, checksum-verified Micromamba. Sunnie can install native tools and libraries from conda-forge into persistent environments, reuse them through `micromamba run`, and save the prerequisites in skills. Local binaries and npm tools are available in every fresh shell. | `Dockerfile`, `src/computer/`, `src/agent/prompt.ts` |
| **Agent Skills** | Discovers standard `SKILL.md` instructions in its persistent home, loads them when relevant, writes its own reusable skills, and installs a selected skill plus resources from an HTTPS Git repository. The user approves each new repository once; source trust is kept in the server database and can be revoked in Settings → Skills. All actions still pass normal tool approvals. **Six skills come with Sunnie, off until the user turns them on** in Settings → Skills: Markdown, Docs (Word), Slides (PowerPoint), Excel, PDF and LaTeX — written for this project, using conda-forge tools (pandoc, python-docx, python-pptx, openpyxl, pypdf, Tectonic) and the computer's Chrome and poppler. | `skills/`, `src/skills/`, `src/tools/skill-tools.ts` |
| **Web search** | With `EXA_API_KEY` set, the agent has `web_search`: Exa's search (`type: auto`) returns up to 10 pages with their title, link, date and the passages that match, optionally limited to one site or to pages published since a date; the agent then reads a result with `web_fetch` or the browser. `web_fetch` also falls back on Exa's crawler when a site answers the direct fetch with 403, 429 or 503, when curl fails, and for PDFs, and says that it did. Unlike every other tool these calls leave from the server, not the agent's computer, so the key never reaches the agent; the server only ever talks to `search.baseURL`, which can later be a gateway that speaks Exa's API. Without a key there is no `web_search` tool and `web_fetch` is unchanged. Helpers and read-only check-ins can search too. | `src/search/`, `src/tools/web-tools.ts` |
| **Web browser** | Google Chrome on the agent's computer (Chromium only where Chrome is not installed) that stays open between steps: open, read, click, type, keys, tabs, back/forward. Pages come back as a text outline with element refs, so any model can drive it (no vision needed). The profile lives in the agent's home, so sign-ins persist across conversations and restarts. New downloads land in `~/Drive/Downloads`. A browser that crashes, freezes or was killed is replaced on the next call. **Hand-off:** for a CAPTCHA, a code sent to the user or a sign-in no saved login fits, the agent calls `browser_handoff` and waits; the user takes the page over in the app (the page laid out for their screen; tap, drag to scroll, pinch to zoom, and the keyboard comes up by itself for a field on the page, hidden for a password), hands it back, and the agent goes on from the page as they left it. The user can also take the browser on their own from the chat menu, to sign in somewhere ahead of time; while they hold it the agent's own browser calls are refused. | `browser/`, `src/tools/browser-tools.ts`, `src/browser/handoff.ts` |
| **Login vault** | Sign-ins saved through the API/app (site, username, password, optional authenticator setup key). The agent fills them by name with `browser_fill_login` — only on the login's own site — and never sees the password; one-time codes (TOTP) are generated on the server. | `src/logins/`, `src/api/server.ts` |
| **Memory** | Three layers: *core memory* (two blocks, `user` and `persona`, in every system prompt), *archival memory* (unbounded, auto-recalled into each turn by meaning — embeddings, `openrouter/voyageai/voyage-4-lite` by default — or by keywords when no embedding model is usable), and the *full conversation history* (searchable forever). In the app, Memory is a folder at the top of Drive (it is not stored there); a server without Drive keeps the Memory tab. | `src/memory/`, `src/store/`, `app/Sunnie/Sunnie/Memory/` |
| **Phone data** | The iPhone can share four sources, each turned on in Settings → Phone data: **Health** (everything the user allows in Apple Health for the last 90 days — every quantity type HealthKit has, day by day in the user's own units, category types such as symptoms, mindful minutes and cycle tracking, sleep per night by stage, State of Mind, workouts and the profile), **Calendar** (events from yesterday to a month ahead), **Reminders** (open items), **Location** (the town, coordinates to about a kilometre), **Contacts** (names, nicknames, organisations, numbers, emails, birthdays, relations, city), **Places** (iOS's visit log kept on the phone for 30 days: arrival, departure, place name; needs location "Always"), **Music** (most and recently played songs, top artists and genres from the library on the phone) and **Photos** (per day over the past year: how many photos, videos and favourites, and the towns they were taken in — never the pictures). The app sends a snapshot when it comes to the front (Health at most hourly, the rest every 30 minutes) and also while closed, when iOS allows: a background app refresh for Calendar and Reminders, and HealthKit background delivery (at most hourly) when steps, energy, exercise, heart rate, weight, calories, sleep, mindful minutes, workouts or moods change. Location is sent only while the app is open; Contacts, Music and Photos at most every 6 hours. The server keeps only the latest per source, and turning one off deletes it. Sunnie reads it with the look-only `phone_data` tool (from/to and a word filter; spans over two weeks come summed up with trends) and the Home brief uses the location and today's events. Calendar text is marked as data, not instructions. Contacts show only a count, upcoming birthdays and family by default; a person's details come with a search. Shortcuts gets an **Ask Sunnie** action (and Siri phrases "Ask Sunnie" / "Tell Sunnie") that sends a message as a new chat and returns the answer, so automations can feed Sunnie anything. | `src/phone/`, `src/tools/phone-tools.ts`, `app/Sunnie/Sunnie/Phone/` |
| **Adaptation** | The agent edits its own `persona` block and saves facts and preferences as it learns them; compaction also extracts durable memories. | `src/agent/prompt.ts`, `src/tools/memory-tools.ts` |
| **Notifications** | The iPhone is told when a run waits for an OK ("Sunnie needs your OK to continue." — the call itself stays off the lock screen), when a run finishes with a reply (the chat's title, then the reply as one plain line), and when a chat run fails. Helpers, the Home brief, quiet check-ins and check-ins that fail stay silent. Sent straight to APNs over HTTP/2 with the team's key (no new dependency); a token Apple rejects is forgotten. The app asks for permission right after the first message it sends, registers its token with the server, groups notifications per chat, shows no banner for the chat on screen, and opens the chat when one is tapped. Settings shows whether notifications are on. Off until `push.apns` is configured. | `src/push/`, `app/Sunnie/Sunnie/App/Notifications.swift` |
| **Interests & discovery** | Clear likes can be registered in the same `memory_save` call that remembers them. The existing heartbeat considers up to three active topics per check-in and decides whether timing and useful new findings merit sharing, staying quiet otherwise. Topic mutes and a global pause persist independently of model recall; mentioning a muted interest again does not resume it. Manage them in chat or Interests & updates under Settings and the conversation menu. | `src/memory/interests.ts`, `src/agent/heartbeat.ts`, `app/Sunnie/Sunnie/Settings/InterestsView.swift` |
| **Heartbeat** | Sunnie keeps a list of follow-ups for itself (`task_add` / `task_list` / `task_update` / `task_done`): reminders, things to watch, work to finish later. Every 10 minutes (configurable) the server looks for follow-ups whose time has come and, if there are any, starts a run for them in a dedicated **Check-ins** conversation — that is where Sunnie reports back unasked. A tick with nothing due calls no model. A check-in that completes closes the follow-ups it was woken for unless the agent moved them to a later time. | `src/agent/heartbeat.ts`, `src/tasks/`, `src/tools/task-tools.ts` |
| **Greeting & quick replies** | A new user is greeted: the first time the one chat opens on a server where nobody has written yet, the app asks the server to start a greeting (`POST /v1/greeting`) and Sunnie speaks first. She says hello, asks what to call the user, which of a few roles fits them (Student, Employee, Business owner, Artist) and one follow-up for that role (an employee's company, a student's studies), saves what she learns to memory, and sets herself up for their work: she looks for published Agent Skills that fit (checking the licence; each new repository is approved by the user) or writes a small one herself. The instructions ride on a hidden opening message (`origin: "greeting"`), so the later turns of the introduction keep them. **Quick replies:** a reply that ends with a `choices` block (one answer per line) gets buttons under it in the app; a tap sends that answer, and "Something else" opens the message box. **The name is fixed:** Sunnie is always Sunnie; there is no `agent.name` setting any more, and the prompt tells her to keep her name whatever the user calls her. | `src/agent/greeting.ts`, `src/agent/prompt.ts`, `app/Sunnie/Sunnie/Chat/QuickReplies.swift` |
| **Home** | The app opens on a Home tab that is a **grid of widgets**, four columns across, drawn in order from JSON the server sends; each widget spans 1 to 4 columns (Sunnie designs to the size: a 1-column tile holds one number, icon or ring). A widget is a tree of primitives: content (`text`, `markdown`, `stat`, `fields`, `list`, `progress`, `gauge`, `chart`, `icon`, `badge`, `button`, `countdown`, `image`, `file`), layout (`row`, `stack`, `grid`, `layer`, `spacer`, `divider`) and style on any part (colour, background, gradient, a Drive picture behind it, padding, corners, border, type size, weight and design), so Sunnie can compose anything from one line of text to a boarding pass or a photo card with buttons. The `home_widget` description teaches Apple's Human Interface Guidelines for them: system type only (no serif — the server drops it and the app never draws it), named text styles, an 8-point spacing grid with padding on every filled card, readable contrast with a scrim over pictures, and at most two buttons. A widget can show and open files from Drive ("pin my travel ticket to Home") and pictures stored there, as a part or as a card's background. Tap actions — on a button, a list line, a whole tile or the widget — open an https link, a chat, a Drive file or folder, or put a prompt in a new chat; which one is up to what the user asked for. **Data and design are apart:** a refresh — the brief's, Sunnie's when asked, or a program's (`PATCH`) — changes only the data of a widget's keyed parts, so it never redesigns what the user set up; the brief may not `set`, move, hide or remove the user's widgets at all. Three writers share one store: Sunnie (`home_widget`, e.g. "put my trip on Home"), the app (on Home itself: long-press a widget and drag it to reorder, or pick Resize in its menu — the new width applies at once and Sunnie redesigns the widget for it while a moving mesh gradient covers it; Edit Home, in place, shows hidden widgets dimmed with buttons to hide, show and remove; or a widget's long-press menu) and any program with the API key (`PUT /v1/home/widgets/:id`). Swiping a widget right (or "Ask Sunnie about this" in its menu) opens a chat with the widget quoted in the composer — its words and numbers as plain lines, with its id — so the user can talk about their steps or their trip; there is no swipe to delete. The app has **no widgets of its own**: everything on Home is what the user asked Sunnie (or a program) to put there, and a Home with nothing on it says what to ask for. Widgets may expire by themselves, and a widget written again keeps the place the user gave it. Once a day after `heartbeat.briefHour` (default 06:00, in the zone the app last reported) the heartbeat runs a **Home brief**: a read-only check-in (at most 10 steps) that refreshes the data of the user's widgets that have gone stale (looking facts up through `phone_data`, `task_list` and `web_fetch`), leaves up to two `note-*` widgets when something really matters that day, and stays quiet in Check-ins. It writes no headline or weather of its own (retired 2026-10-06: the user found them ugly); weather on Home is a widget the user asks for. Home can also ask for one (`POST /v1/home/brief`). Check-ins live behind a toolbar button on Home and Chats, with a dot when there is news; check-ins that came to nothing are hidden. | `src/home/`, `src/tools/home-tools.ts`, `src/agent/heartbeat.ts`, `app/Sunnie/Sunnie/Home/` |
| **Helpers (parallel work)** | When a task splits into independent pieces of legwork — hotels across three areas, a price at ten shops — Sunnie hands each piece to a helper with `delegate` and they work at the same time (5 at once by default, up to 10 per call), each with its own browser tab. A helper is a smaller Sunnie: the same turn loop (router, risk filter, retries) on a short prompt, with tools to look things up and nothing else — no memory, no follow-ups, no saved logins, no helpers of its own. Helpers are sent and forgotten: a helper works from its task alone, never talks to the user, and reports once to the main Sunnie; a call that would need approval is refused to it and comes back in the report, for the main Sunnie to do where you are asked. Only when the main Sunnie sets `allow_questions` on a call may those helpers end a report with a question, which it answers (asking you if it must) with `helper_message`; the helper then carries on with what it had. The main Sunnie gets the reports as the tool result and writes the one answer. Each helper's transcript is kept and readable through the API. | `src/agent/subagents.ts`, `src/tools/delegate-tools.ts`, `browser/daemon.ts` |
| **Compaction** | When context outgrows its budget, older messages are folded into a rolling summary (chunked if long), durable memories are saved on the way out, recent messages stay verbatim. Nothing is deleted. A failing summariser never fails the turn. | `src/agent/compaction.ts` |
| **Resilience** | Model calls that fail transiently (rate limit, overload) before producing output are retried with backoff; so is compaction. | `src/agent/retry.ts` |
| **Durable runs** | A run is written to the database when it starts, and every tool call that acts (anything but a read) is written down before it runs. When the server starts it takes up the runs the last process left unfinished — after a crash, a kill or an ordinary redeploy — under the same run id, from the last stored step. The model is told which actions of the lost step had already begun, so it checks before doing one again. A check-in that is picked up still closes its follow-ups. A run restarted three times without finishing is ended as failed. A send can carry a `requestId`, so a client that retries after a dropped connection gets the run its first attempt started instead of asking twice; a run that has ended can still be read and re-attached to after a restart, its stream rebuilt from the stored messages. | `src/agent/runs.ts`, `src/store/runs.ts`, `src/agent/agent.ts` |
| **Attachments** | Images, PDFs and documents from the chat composer or the iOS share sheet. Authenticated, idempotent uploads preserve originals; messages and queued steers retain attachment metadata. Original working copies reach the agent through `Computer.exec`; compatible models receive native images/PDFs, and text/DOCX/PPTX/XLSX files get bounded text extraction. | `src/attachments/`, `src/store/attachments.ts`, `app/Sunnie/SunnieShare/` |
| **API** | Conversations, messages, SSE streaming, runs that survive disconnects (replay + resume), cancel, memory and core-memory management, read-only task list. Bearer-token auth. | `src/api/server.ts` |
| **Steering** | A message sent while a run is at work (`POST /v1/runs/:id/messages`) is queued in the database and joins the run between two of its steps, stored as the user's next message; the turn's step budget starts over with it. If the answer was already being written, the turn carries on with the message instead of ending; if the run ends first, the message becomes the next run. Several waiting messages join as one. A run that is stopped or fails drops what was waiting. Queued messages survive a restart with their run. | `src/agent/agent.ts`, `src/agent/runs.ts`, `src/store/runs.ts` |
| **Cards** | The prompt teaches the agent four fenced blocks — `event`, `schedule`, `card`, `drive` — written as plain `key: value` lines; the app draws them as cards and any other client shows a code block. A fifth, `widget`, is a card the agent designs itself: a Home widget body as JSON (the same parts, layout, colours and buttons), drawn in the reply. **Cards are interactive:** steppers, sliders, toggles, segmented tabs and checklists (a timeline when items have times) set named values, any text the card shows may hold `{formulas}` worked out live (`{round(people * 0.4, 1)} kg`), `when` shows a part only while a formula holds, and buttons can `reply` (send their words as the user's message, like a quick reply — chat cards only), `copy` or offer an event to the calendar. What the user sets is saved on the server per message and card, so every device shows the same card and Sunnie hears about it with the next message. A card streams in part by part (the app closes the half-written JSON and draws what has arrived); one the app could not draw is repaired before the step is stored (trailing commas and cut-off endings by hand, anything else by one short call to the conversation's model), and a block that still does not read falls back to code. Long-press a card → **Add to Home** pins it as it stands; it keeps working there and Sunnie can keep it current. Drive references open the current file or folder at the named path. Recommended WhatsApp messages use a quotable `card` with the draft and an **Open in WhatsApp** `wa.me` shortcut. Helpers are not taught cards. | `src/agent/prompt.ts`, `app/Sunnie/Sunnie/Chat/RichViews.swift` |
| **Quoting** | Swipe a rich card or a Home widget right, use its menu/accessibility action, or select message text and choose Quote. Several removable quotes can accompany a message, including a steer or a send with no typed text. Sent quotes expand in history and preserve snapshots through retries, restarts and compaction. | `src/store/quotes.ts`, `app/Sunnie/Sunnie/Chat/QuoteViews.swift` |
| **Deployment** | Two Ubuntu installers: Docker Compose or a native systemd service. Both install prerequisites, preserve credentials and data on reruns, enable startup after reboot and bind to localhost for a tunnel. Native agent commands run as the selected Linux user; server code, keys and database remain root-owned. | `install-docker.sh`, `install-native.sh`, `scripts/install-common.sh`, `api/Dockerfile`, `api/docker-compose.yml` |
| **iOS app** | Light-only, native look with the Sunnie logo as app icon, launch image and empty-state mark; leaf-green tint. Logins screen under Settings (add, edit, delete; secrets are write-only). SwiftUI, iOS 26+, no third-party dependencies. Connect screen (server URL + API key, key in the Keychain; or **Scan code**, which reads a host's one-time connect link from a QR code — the same link opens the app as `sunnie://connect?link=…`); saved servers — every server that worked is remembered (address and name in UserDefaults, each key in the Keychain), so Settings → Servers and the connect screen switch between them with a tap, Add server connects a new one, a swipe removes one and Disconnect removes the current one; conversation list; chat with streamed text; reasoning and tool calls folded into one plain-language line per stretch of work ("Ran 2 commands and used the browser", or what it is doing right now), tap to see the details; stop, rename, per-conversation model switch, manual compaction, "load earlier" paging; re-attaches to a run that is still going when the app comes back, and follows a run through a server restart (it keeps trying for about a minute and a half); every send carries a request id and is retried under it when the connection drops before an answer; replies are drawn as rich text — headings, nested and numbered lists, checkboxes, quotes, tables, code, links (a line that is only a link becomes a link row) — and the agent's `event`, `schedule` and `card` blocks as cards (an event with its date, a tappable place and a calendar file to share); a follow-up the agent set and a thing it remembered show as a small card under the steps; a check-in's opening message shows as a quiet clock line rather than a user bubble; Memory as a folder in Drive (archival list/search/add/edit/delete, core memory editor); settings tab (instance info, models, providers, disconnect). **One chat** (the default; a self-hosted build can turn it off in Settings): the Chats tab becomes a single ongoing conversation with Sunnie, drawn as message bubbles under an avatar header, like texting a person; Home's asks and widget quotes land in it, Check-ins and notification chats open on top of it, and "Start a new chat" begins a fresh one. The app remembers which conversation it is per server; the server knows nothing of the mode, so other conversations come back when it is off. | `app/Sunnie/` |
| **App Store app (hosted flavor)** | The same app built with `SUNNIE_FLAVOR=hosted`, for people on the hosted service. Signing in is the hosted panel's code: scanned (iOS camera; a pasted link or a picture of the code on the Mac) or typed, a typed code being claimed at `https://<SUNNIE_CONNECT_HOST>/c/<code>` like a scanned link. No address or API key fields, no saved-servers list. One chat always (no toggle). Settings keeps to Sunnie's name, Logins, Skills, Phone data, Notifications, Interests and **Sign out**; gone are the model for new chats, the memory count, the servers, the address and key, and server details. Chats lose the model menu, Compact context and the token counts under a reply. The self-hosted build is unchanged apart from one chat becoming the default and the memory count leaving Settings (memory is in Drive). | `app/Sunnie/Sunnie/App/AppFlavor.swift`, `Settings/ConnectView.swift`, `Signing.xcconfig` |
| **Mac app** | The same app, native on macOS 26+: the iOS app's target builds for the Mac too (one bundle ID, one codebase, the same 112 unit tests), so every screen and flow is shared — Home and its widgets, chats with approvals, steering, quotes and cards, Drive (Quick Look previews, Open in Default App), Memory, Logins, Skills, Interests, model defaults, saved servers, one chat, notifications, the share extension and the Ask Sunnie action. What differs is the Mac's way between screens: one window with a sidebar (Home, Check-ins with its dot, Drive or Memory, Settings, then the conversations themselves, with Delete in their context menu), ⌘N for a new conversation, ⌘, for Settings, ⌘R to refresh; Return sends and Option-Return starts a new line; files dragged onto a chat attach. Closing the window keeps Sunnie running. Connecting takes a pasted connect link or a picture of the QR code (a file or the clipboard) instead of the camera. **Device data** offers Calendar, Reminders, Contacts, Location and Photos, sent at launch and every 15 minutes while Sunnie runs; Health and Music have no source on a Mac, and Places is left to the iPhone because the server keeps one copy per source. Sandboxed, light only like iOS. | `app/Sunnie/Sunnie/Mac/`, `app/Sunnie/Sunnie/Design/Platform.swift` |

### Verified

The 2026-10-03 Drive download permission fix passes a signed iPhone build and is installed on
the paired iPhone. Drive and chat downloads now write the response bytes atomically
to an app-owned file, avoiding the CFNetwork temporary-file import that failed on the phone.
The existing 20 MiB transfer limit, original filenames/bytes and empty Drive files are preserved.
Tests, lint and formatting were not run; regression sources were added but not executed.
The phone was locked, so remote launch was refused; preview and sharing still need manual
confirmation. The server was not changed.

The 2026-10-03 Drive update is deployed to OrbStack and installed on the paired iPhone.
The signed device build passed, and the phone's installed-app inventory confirms Sunnie. Launch
was refused because the phone was locked. The running API uses the rebuilt image, is healthy,
and returns authenticated Drive capabilities and folder listings over localhost and the existing
private HTTPS route. Schema 13 retains all conversations, messages and attachments, with
both persistent volumes preserved. A disposable Linux container also completed Drive creation,
read/edit, move and folder deletion as the unprivileged `sunnie` user. Tests, lint, formatting and
paid inference checks were not run; on-phone interaction remains unverified.

The 2026-10-03 Drive implementation passes the API type check (including new regression sources)
and an iOS Simulator build. Manual HTTP requests against an isolated offline server confirmed
folder/file creation, listing, reading, editing, stale-save rejection, moves, deletion and path
traversal rejection. Editing an uploaded Drive copy left its original attachment unchanged.
Tests, lint and formatting were not run. Simulator UI interaction could not be reviewed because
Simulator was unavailable to this session's computer-use tools. Deployment and installation
were completed afterwards, as recorded above.

The 2026-10-03 reply-visibility fix passes simulator and signed iPhone builds. A scratch API
with scripted tool calls and long card replies reproduced the old screen remaining on the
previous message, and the rebuilt app visibly followed incoming text and completed replies.
Read-only inspection of the reported production conversation confirmed that both answers
were present in history and SSE replay. The fixed app is installed on the paired iPhone;
the API was restarted, is healthy locally and over private HTTPS, and retains all
conversations and messages. No server-code or API-contract changes were needed.
The phone was locked, so the installed app could not be launched remotely.
Tests, lint and formatting were not run. Scrolling away during streaming, suspended-connection
recovery and physical-device interaction still need manual coverage; reducer regression
sources were added but not executed.

The 2026-10-03 quote, heartbeat-interest and WhatsApp-card updates are now deployed: the signed
app was installed on the paired iPhone, and the OrbStack API was rebuilt and restarted
with its existing data and home volumes. The API is healthy locally and through the private
HTTPS route; authenticated endpoints advertise quoting and interest discovery on the existing
10-minute heartbeat. The phone was locked, so launching the installed app could not be verified.
Tests, lint and formatting were not run.

The 2026-10-03 WhatsApp shortcut change passes the API type check and an iOS Simulator build.
Manual review with a scratch server confirmed the draft, action label, swipe-to-quote and
handoff to WhatsApp's website. The stored URL retained the full draft; WhatsApp's web redirect
replaced the sample emoji with a replacement character. Handoff to an installed WhatsApp app
and real-model draft generation remain unverified. Tests, lint and formatting were not run;
no deployment or physical-device installation was made for this change.

The 2026-10-03 quoting and interest-update implementation passes the API type check and an
iOS Simulator build. A separate simulator connected to a scratch server with scripted replies
confirmed card quoting, the selected-text Quote menu, multiple draft quotes, removal, quote-only
and text-plus-quote sends, expanding saved quotes after reopening, topic mute and global pause. No real provider calls, deployed
service changes or physical-device installation were made for this change. Regression test
sources were added; tests, lint and formatting were not run, as requested.

The 2026-10-03 Agent Skills implementation passes the API type check and a signed iPhone build.
The app was installed and launched on the paired iPhone. Docker was rebuilt and
restarted with the existing volumes; its health check, authenticated skills catalog and private
HTTPS health route respond successfully. Tests, lint and formatting were not run, as requested.
New regression test sources were added but not executed. Real-repository installation and
live-model skill selection, authorship, approvals and prompt-cache behavior remain unverified.

The 2026-10-03 attachment and share-extension work passes `pnpm typecheck` and simulator/device
`xcodebuild build`. Manual simulator review confirmed a photo upload and Safari PDF sharing into
an existing chat, saved attachment history, and authenticated original-file preview, using an
isolated server with scripted responses. The app and embedded extension were installed on the
paired iPhone and the app launched. The updated OrbStack API is healthy through the existing
private Tailscale HTTPS route. No tests, lint, formatter or paid model calls were run for this work.
HEIC conversion, Office extraction and real-provider media understanding were not exercised live.

The 2026-10-03 iOS interface refinement compiles with `xcodebuild build` and was reviewed
manually on an isolated iPhone 17 simulator with sample data (including chat and memory at an
accessibility text size). Tests, lint and formatting were not run for that change, as requested;
the automated results below describe earlier revisions.

Automated:

- `pnpm check`: type check + **97 tests**, green on macOS (Node 26); the tests also pass on Linux (Node 24, inside the image). The suite uses the AI SDK mock model, a scripted OpenAI-compatible server, and a scripted TypeSafe server — no network. One browser test drives a real Chromium against a site served by the test itself (sign-in from the vault, password hidden from the result, wrong-site fill refused, new tab, two helper sessions opening pages at the same time in tabs of their own, still signed in after a browser restart); it is skipped on a machine with no Chromium or Chrome.
- iOS app, `xcodebuild test` (scheme `Sunnie`, iPhone 17 simulator, Xcode 27): **29 unit tests** (steering: pending messages, their return to the composer; SSE parser, event decoding, timeline reducer incl. held tool calls, check-in openers and a run that starts again after a restart, folding steps into one line, Markdown blocks, lists, tables, lone links and bare URLs, the three card blocks, the calendar file of an event, follow-up and memory cards, URL normalisation, login DTO) — no network. Plus one opt-in UI smoke test (`SunnieUITests`) that drives the real app against a running server: connect, create a chat on first send, a shell tool round trip that is held and allowed, a held call that is denied, streaming then stop, rename, reopen with history, memory add/edit, core memory editor, settings, saving a login. Skipped unless `TEST_RUNNER_SUNNIE_LIVE_URL` / `_KEY` are set.
- iOS app against the real server on 2026-10-01: the UI smoke test above, with the server on the scripted fake provider (`api/test/fake-provider.ts`), so the whole HTTP + SSE path was exercised without a model.
- **iOS app with real inference, 2026-10-01** (`openrouter/openai/gpt-6.1-sol`, medium reasoning, Jev router on; 4 model steps, about 7.5k input tokens of which 5.4k cache reads, 250 output — well under a cent): from the simulator, a first turn that ran a shell command and answered with Markdown; a second turn in which the agent appended to its `persona` core block and answered. The app was sent to the background mid-run and brought back: it caught up on the finished run from the server. The Memory tab showed the agent's core-memory edit; the usage line showed per-run tokens and cache share.
- **App + real model + risk filter end to end, 2026-10-01** (iOS simulator against a local server, `openrouter/openai/gpt-6.1-sol` at medium reasoning, Jev router and Jev approvals on; two turns, 14 model steps, about 250k input tokens of which 211k cache reads, 767 output): "weather in Singapore today" — one `web_fetch` of Singapore's official forecast API, correct answer; "cheapest one-way SIN→Tokyo on 15 November, top 3, via Google Flights" — the headless browser opened, read and clicked through Google Flights (not blocked) and returned three priced options with a recommendation. The risk filter held none of the calls (all read-only). Screen-recorded for the user. Seen: the answer's Markdown table shows as raw pipes (known: no table rendering).
- **Browser with real inference, 2026-10-01** (`openrouter/openai/gpt-6.1-sol`, medium reasoning, Jev router on; one turn, 6 model steps, about 19k input tokens of which 14.7k cache reads, 170 output — under a cent): asked to sign in to a local test site with the saved login, the agent opened the page, filled username and password from the vault, picked a dropdown option, submitted and reported the signed-in page. The password reached the site and appears nowhere in the stored messages. Cache reads were 88–94 % of input from the second step on.
- **Browser in Docker, 2026-10-01**: the image builds with Google Chrome stable (154, linux/arm64); as user `sunnie` the browser starts, reads a page, and keeps a session cookie across a browser restart; the server's data directory stays unreadable to that user. Image size is now about 2.2 GB.
- **Robustness pass, 2026-10-02** (the Docker image on an Apple-silicon Mac; Chrome 154 headed on Xvfb):
  - *Real sites, no model:* about 30 pages opened through the browser client as user `sunnie` — Wikipedia, Hacker News, GitHub, BBC, NYT, Amazon (home and search), Twitch, YouTube (home and a video), Reddit, Booking, LinkedIn, X, Instagram, Tokopedia, Google Maps — each in 1–5 s with a readable outline and no tab crash. A scripted flow worked end to end: Wikipedia search by typing and Enter, paging the outline, back, a link click on Hacker News, a key press, and GitHub's sign-in form filled with a wrong password (hidden in the outline; GitHub answered "Incorrect username or password"). A PDF, a file download, an invalid certificate, an unknown host, an empty 404 and a site that never answers each produce a message the model can act on.
  - *API under misuse, no model:* missing and wrong token, broken JSON, empty text, a 2 MB body, an unknown model, an unknown conversation, a bad query value, 200 concurrent requests (all answered, 184 ms), a memory search full of FTS operator characters.
  - *Live, `openrouter/openai/gpt-6.1-sol`, Jev router, approvals and recall on:* one turn that read Hacker News in the browser and started a background web server in the shell (3 steps, 16 s, 18k input tokens of which 10.8k cache reads); the container killed with `docker kill` in the middle of a run, after which the conversation was intact (the user message, no dangling tool call) and answered the next message. Total spent on live runs in this pass: about 89k input tokens (65k of them cache reads) and 650 output tokens, plus a few dozen Jev requests.

- **Helpers with real inference, 2026-10-02** (scratch instance, `openrouter/openai/gpt-6.1-sol` at medium reasoning, Jev router, approvals and recall on, browser headless, helpers limited to 8 steps): asked for a hotel in Bali for given dates "in Ubud, Canggu and Seminyak", the agent called `delegate` by itself with three self-contained tasks (the router was unsure, 0.52, and left the choice to the model); the three helpers started together and drove Booking, Expedia and Agoda in three tabs at once (24 helper steps in 63 s — about what one of them took alone); their reports came back as one tool result, and the agent saved the plan to memory and answered. 305k input tokens, of which 238k cache reads, 3.8k output. The answer itself was thin, and said so: the sites dropped the dates or asked for human verification from the headless browser, and all three helpers used up their 8 steps. A second task (four cities' figures from Wikipedia) was done without helpers, with four parallel `web_fetch` calls in one step — the right call for one-step pieces (118k input, 63k cache reads, 2k output). Cost not looked up.

- **Approvals in the app, 2026-10-01**: the UI smoke test against the real server on the fake provider, with the risk filter pointed at a Jev that does not answer (so every tool call is held): the held call shows its command with Allow / Deny; Allow runs it; Deny leaves it unrun and the model is told. 16/16.
- **Memory decisions, live, 2026-10-01** (about 45 Jev calls, through both endpoints; OpenRouter reported $0.00003 for one; plus 7 model steps on `openrouter/openai/gpt-6.1-sol` at medium reasoning, about 12.8k input tokens of which 6.9k cache reads, 470 output — about a cent at most). *Store:* of 11 hand-written messages the "worth remembering?" question scored the 4 with something durable 0.91–0.98 and the other 6 asked ones 0.04–0.10 (questions, a task, small talk, a passing detail, a fact already remembered, a password); two of the four had a routing confidence below the threshold (0.54, 0.62), so without the question saving would have been left to the model. *Recall:* over 10 candidate memories, the helpful ones scored 0.75–0.97 and the others 0.02–0.34. End to end on a scratch server: "I'm vegetarian by the way, and my sister Maya's birthday is 14 March. What's a quick dinner idea for tonight?" produced two `memory_save` calls and then the answer; in a new conversation "what could I cook for dinner on Sunday?" got "The user is vegetarian" attached (0.97; the birthday 0.02) and a vegetarian answer, and "what is 17 times 23?" got nothing attached. Before recent memories were nominated, the same Sunday question found no keyword match and the answer suggested chicken. Cache reads were unaffected (87–98 % of input after a conversation's first request).
- **Jev risk filter, live, 2026-10-01** (20 Jev calls, no language model; cost not reported by the API, expected to be a fraction of a cent): 10 hand-written tool calls through both endpoints (TypeSafe direct and OpenRouter). The 5 routine ones (list, read, memory search, fetch, write a note) scored 0.02–0.14; the 5 risky ones (`rm -rf` of documents, force push, sending mail with curl, a "Place order and pay" click, `DROP TABLE`) scored 0.92–0.98. 250–700 ms per call.

- **Heartbeat with real inference, 2026-10-01** (`openrouter/openai/gpt-6.1-sol`, medium reasoning, Jev router and approvals on, heartbeat every 30 s on a scratch instance; three short sessions, 15 model steps, about 54k input tokens of which 31k cache reads, 820 output — a few cents at most, not looked up): asked in a chat to "check the UTC time on your computer in about a minute, then once more a minute later, on your own", the agent added a follow-up with the right local due time and said it would; the heartbeat woke it in the Check-ins conversation, it ran `date -u`, scheduled the second check, and reported; the second check-in ran, reported, and its follow-up was closed. The first two sessions found two problems, both fixed and covered by tests: the tool router forced "reply" straight after the tool result, so the agent could neither close nor reschedule a follow-up (now: completed check-ins close their follow-ups themselves, and the router reads a check-in's instructions).

Live, on 2026-09-30 (total spend about $0.03):

- **`openrouter/openai/gpt-6.1-sol`, medium reasoning** — multi-step turns with parallel tool calls, file tools, shell, core-memory edits, forced tool choice from the router, a manual compaction (well-formed summary, no duplicate memories) and continuing from the summary.
- **Prompt cache**, same model: after a conversation's first request, **86–96 % of input tokens were cache reads** on every step — across steps, across turns, across a core-memory edit, and across changing `tool_choice`. The first request after a compaction is a miss, as expected; the next ones hit again.
- **`openrouter/typesafe/jev-router`** (OpenRouter's model router; the default until 2026-10-02, no longer used): picked `openai/gpt-6-luna`, stayed on it for the whole conversation, accepted forced tool choice, 86–93 % cache reads after the first request. The `jev-router` plugin options in the example config are accepted.
- **Jev tool routing**: 14 of 14 hand-written scenarios chose the expected action, through both endpoints (TypeSafe direct and OpenRouter), roughly 250–520 ms per decision. Confidence ranged 0.38–1.00; 10 of the 14 cleared the default 0.7 threshold, so the other 4 would have been handed to the language model.
- **Transient-failure retry**: OpenRouter returned "temporarily rate-limited upstream" for gpt-6.1-sol several times during testing; the retry recovered each time once it was in place.
- Real server process over real sockets: streaming, client disconnect mid-run, re-attach with replay, cancel, graceful shutdown.
- Docker image: builds, reports healthy, agent commands run as user `sunnie`; from inside the agent's shell the server's environment, data directory and config are **not readable**.

### Not verified yet

- **App Store (hosted) flavor:** written without Xcode: neither flavor has been built since, and
  the unit tests (`AppFlavorTests`, new `ConnectLinkTests` cases) have not run. Not seen on a
  screen: the code connect screen, the trimmed Settings and chat menu, sign-out. Claiming a typed
  code depends on the hosted panel serving `https://<host>/c/<code>` for the code it shows.

- **Connect links:** the camera scanner, the camera permission prompt and opening a
  `sunnie://connect` link from Safari need a physical iPhone (the simulator has no scanner, so
  the button is hidden there). Claiming against a real host from the app has not been tried; the
  parser and the response decoding are unit-tested.

- **Ubuntu installers:** reviewed as source only; fresh VPS installation, Docker builds, native
  browser startup, reboot recovery, update/failure handling and tunnel access have not been run.
  Offline regression sources cover credential files and deployment copying, but are unexecuted.

- **Drive and model settings:** tap-to-open interactions, cache reuse on a phone, Quick Look/share handoff, saved model/effort with a real provider, accessibility, real-model card generation,
  browser downloads to the new location and prompt-cache metrics. The new API
  boundary, persistence and card-parsing regression sources have not been executed.

- **Interest discovery with real models:** recognizing likes and opt-outs, topic aliases,
  finding fresh worthwhile content, avoiding semantic repeats, cost over several days and
  prompt-cache metrics. Heartbeat eligibility, quiet replies, stored opt-outs and quote/steer paths
  have new regression test sources, but those tests have not been run. Physical-device
  gestures, VoiceOver and the full range of accessibility text sizes remain to be reviewed.

- **Approvals with a real model in the loop**: the risk filter was checked live on its own and the hold/allow/deny path with the fake provider, but not together in one real run. The 0.5 threshold is a starting point, not tuned on real traffic. Browser actions are the weak spot: a click is judged from `ref` plus the page outline in the previous tool result, which was not tried live (the live "pay" case named the button in the input).

- **Helpers:** one live run of three helpers (see Verified), made before `allow_questions` and `helper_message` existed — those two, and the prompt wording around them, are covered by tests only. Not tried: ten at once (provider rate limits, Chrome's memory in the container), the default 15 steps on a headed browser, a helper that hits a held call with a real model, helpers on the default Muse model or any weaker one (does it write tasks that stand alone? does it delegate too eagerly?), a check-in that sends helpers, and the daemon's new per-tab recovery when one page hangs (unit-tested paths only cover the normal case). The app shows a `delegate` call as one "Sent out helpers" step; the `subagent.*` events are ignored by it and were not looked at in the simulator.

- **Heartbeat over real time**: only one-minute follow-ups on a 30-second heartbeat were tried live. Not tried: the default 10-minute interval over hours, a held tool call inside a check-in, several follow-ups due at once with a real model, a long-lived Check-ins conversation reaching compaction, and how well a weaker model decides what deserves a follow-up or a message. The app's check-in line is unit-tested but was not looked at in the simulator.

- The browser against real sites, beyond what is listed under Verified: CAPTCHAs and sites that refuse an automated browser (Google Search answered with its "unusual traffic" page), a real sign-in that succeeds, real two-factor flows, cookie banners that cover a page. One-time codes are checked against the RFC 6238 test vectors, not against a real account. The frozen-browser path (75 s limit) and the page-crash path were not reproduced once the crash below was fixed.
- The Logins screen's edit and delete paths were not driven by the UI test (create, list and reopen were).

- Any model other than the two OpenAI ones above, and the eleven others benchmarked on 2026-10-02 — all of them through OpenRouter only, whether through OpenRouter or directly. In particular: whether each **accepts a forced tool choice** (if one does not, set `router.mode` to `"active-tools"`). Anthropic's caching is verified directly (2026-10-08), not through OpenRouter.
- The direct (non-OpenRouter) provider paths. They share the agent code but have never made a real call.
- Long conversations: automatic compaction at the real 100k-token budget, and summary quality over many compactions.
- Behaviour quality over time — does it save the right memories, does the persona adapt well. That needs real use.
- The router's 0.7 confidence threshold is a conservative starting point, not tuned on real traffic.
- Context windows in `sunnie.config.example.json` are from OpenRouter's model list on 2026-09-30.

### Known limitations

- **Drive:** app transfers and previews are limited to 20 MiB per file, and editing to 256 KiB of
  UTF-8 plain text. Office documents and PDFs use previews/downloads; there is no formatted-document
  editor. Listings page in groups of 200 and reject folders over 10,000 entries. Symlinks, hard-linked
  files and special files cannot be opened through the API. Cards and attachment `drivePath` values
  reference paths, so moving/deleting an item can make older links unavailable. Existing files
  outside Drive and historical chat uploads are not migrated. Saves compare filesystem revisions
  before replacement; app mutations are serialized, but arbitrary shell writes are not transactional
  with app operations. Deletion is permanent after confirmation, with no trash/version history.

- **Interest discovery:** the existing `heartbeat.intervalMinutes` cadence determines when
  active interests are considered, with due follow-ups taking priority and no separate daily
  limit. A new interest can be considered on the next available tick. An eligible check-in
  costs a model turn even if it decides to stay quiet. Each check rotates through up to three of at most
  50 remembered topics, with at most eight model steps (or the configured lower limit) plus a
  tool-free wrap-up. The prompt asks for no more than three source pages and three findings;
  novelty and topic interpretation still depend on the model. Quiet checks keep their activity
  history without a filler reply. Existing archival memories are not scanned automatically;
  likes are registered when stated in conversation. Muting preserves the remembered preference,
  and pausing discovery leaves requested reminders alone. No push delivery is implemented.
- **Durable runs:** a restart loses the run's event stream and the step that was in progress (streamed text of that step is gone; the step is asked of the model again). A tool call that was running is not repeated by the server, but whether it is repeated at all is the model's judgment from a note — a weak model may redo it. A call that was waiting for approval is asked about again (nothing is kept of an answer, because an allowed call runs at once and is then covered by the note). Helpers that were at work are lost with their `delegate` call; the main agent is told and decides whether to send them again. The app follows a restart for about a minute and a half; after that the chat catches up when it is reopened. A finished run's stream, asked for after a restart or after its ten minutes in memory, holds only `run.started`, its messages and how it ended.
- **Approvals:** every tool call costs one more Jev request (about 0.3 s) before it runs. A held call waits until it is answered or the run is cancelled — there is no timeout, so an unattended run can sit waiting; only a check-in gives way, and only once another follow-up is due behind it (`heartbeat.approvalWaitMinutes`). A failed risk question is asked once more before the call is held as "could not judge". `stream: false` requests block the same way; answer through the approvals route from another connection. While Jev is unreachable every tool call asks (`approvals.onError: "allow"` changes that). With no TypeSafe or OpenRouter key the filter is off and nothing is held. The filter sees the recent, clipped conversation and the call's input, sent to TypeSafe (directly or via OpenRouter).
- **Heartbeat:** there are no push notifications, so an update from a check-in waits in the Check-ins conversation until the app is opened. Follow-ups are only looked at when a tick fires, so they run up to one interval late, and the first tick is one interval after the server starts. A check-in whose tool call is held for approval waits for an answer, and no other check-in starts meanwhile. A follow-up is closed when its check-in completes unless the agent moved it — if the agent forgets to move a repeating one, it stops repeating. A check-in that fails or is cancelled is retried after `heartbeat.recheckMinutes`. Each check-in is a model run and costs what a short turn costs. The task list is read-only in the API and not shown in the app; ask Sunnie in chat to add, move or drop a follow-up. Deleting the Check-ins conversation is fine: the next check-in starts a new one.
- **Helpers:** they cost what they do — each is a run of up to `subagents.maxSteps` model calls with its own context, so ten helpers can spend several times what the main turn does; their tokens are included in the run's `usage`. Whether to use them is the model's (and Jev's) judgment from the tool's description and a prompt section; there is no hard rule. A helper knows only what its task says plus the `user` core block, and by default cannot ask: it assumes, and says what it assumed. A helper cannot be given approval: an action judged high risk is refused and comes back in its report for the main agent to do. A helper that is answered with `helper_message` starts that turn with a new browser tab and a fresh `subagents.maxSteps`. Helpers share the computer's files and the browser's sign-ins, but cannot use the login vault. While helpers work the app shows one "Helpers are at work…" line, not what each is doing. If the server restarts mid-run the helpers' transcripts stay but the run is lost, as for any run. Helpers do not write memory: what they find is remembered only if the main agent saves it.
- A turn has `agent.maxSteps` model calls (40). When they are used up, one more call without tools lets the agent say where it stands; the run then completes with `finishReason: "step-limit"` and "continue" starts a new turn.
- One run per conversation at a time: a second `POST …/messages` gets `409`; to say more to a run at work, steer it. A steer is not recalled for (no memories are attached to it), waits for the step in progress to finish — it does not interrupt a long command or a held approval — and is dropped if the run is stopped or fails (the app puts it back in the composer).
- **Attachments:** up to 8 files, 20 MiB each and 40 MiB per message. Native image input supports JPEG, PNG, WebP and GIF; the iOS app also uploads a bounded JPEG rendition for decodable formats such as HEIC/HEIF while preserving the original; PDF/image understanding depends on the selected model. Plain text and DOCX/PPTX/XLSX extraction does not interpret embedded visuals or all formatting; old Office binaries and other formats remain available as originals on the computer. Scanned PDFs need a model that can read them. Originals are retained even if a conversation is deleted; there is no attachment cleanup API yet. Voice/video input is not implemented.
- **Browser:** a long page comes back as a very long outline (a Wikipedia article was 280,000–970,000 characters, read 12,000 at a time); `browser_read` with `find` jumps to the matching lines, and for plain reading `web_fetch` is the better tool. On Apple-silicon hosts (M4 and later) Chrome needs the workaround in `browser/nosme.c`, which the image builds; without it tabs crash on image-heavy pages. It is still an automated browser, which some sites detect and block even with a real window (Google sign-in is a likely example), and it cannot solve CAPTCHAs — the agent has to ask you. `browser_screenshot` shows the model the page as a picture (JPEG of the 1280×900 window); no hover. Codes sent by SMS or email have to be relayed by you in chat. One browser is shared by all conversations (helpers get tabs of their own in it, and those are closed when they finish).
- **Login vault:** passwords are stored unencrypted in the server's database (root-only in Docker, like the provider keys). The agent is not shown them and they are not sent to the model, but this is not a hard boundary: the value is typed into a page on the agent's own computer, and the browser profile (cookies) is in the agent's home. A login is filled only when the page's host matches its site.
- **Core memory in the prompt is a snapshot.** To keep the prompt cache valid, an edit to core memory reaches the system prompt at the next compaction, after 30 minutes of inactivity, or in a new conversation. Within the conversation the agent sees its own edits as tool results; edits made through the API or from another conversation are not visible until the refresh.
- A confident routing decision forces exactly one tool for that step, so the model cannot batch different tools in it. (Requests that need several tools tend to score low confidence and fall back to the model, which can batch.)
- The agent has no root on its machine (by design, to protect server secrets). Micromamba, Python virtual environments and local binaries cover user-space software, but package availability depends on the platform/channel. Kernel drivers, privileged services and system configuration still need administrator work or a separate computer.
- Memory recall is not filtered per memory: when Jev says a message calls for a recall, the `recallLimit` (6) memories nearest in meaning ride along, relevant or not (there is no similarity floor yet; in the live check "What should I cook tonight?" brought the diet and the allergy, and four unrelated memories), with up to five earlier messages cut to their opening and close. Semantic recall sends every memory's text once, and each message with the three before it (400 characters each), to the embedding provider; it adds about 0.35 s to a turn that has memories, overlapping the Jev decision. When the provider does not answer within `memory.embedding.timeoutMs`, or no embedding model is usable, recall is by keywords (FTS5 + stemming, the message and the turns before it) topped up with the most recent memories, which finds 5% of what a reworded question needs (`api/bench/`). Earlier conversations are still searched by keywords only, and so are `memory_search` and the duplicate check in `memory_save`. An outdated memory is not retired by itself: `memory_save` names the stored memories a new one resembles, and removing the old one is left to the model.
- **Memory decisions:** every turn that has anything to recall (a memory, or a matching earlier message) costs one Jev request (about 0.3–0.7 s) before the first model step. While Jev is unreachable the recall happens anyway; with no TypeSafe or OpenRouter key every message gets its keyword matches and nothing from earlier conversations. A confident "worth remembering" always routes to `memory_save` (archival), also for a style correction that belongs in the `persona` block.
- Token counts are estimated (chars ÷ 3.5), corrected by provider-reported usage once a call has happened.
- Routing sends the recent, clipped conversation to TypeSafe (directly or via OpenRouter). Jev is English-first.
- Single user per instance; no TLS or rate limiting built in — put a reverse proxy in front.
- The iOS app allows plain `http://` (App Transport Security is disabled) because a self-hosted server is usually on a LAN or Tailscale IP. Use https for anything exposed to the internet.
- The app's Markdown is its own small reader, not a full CommonMark one: no images, no nested quotes and no HTML. Text selection works within a rendered text block; a card's Select text menu opens its snapshot for selection. A card's times are read as the phone's local time. "Share as calendar event" hands a `.ics` file to the share sheet; adding it straight to the calendar would need EventKit, which the app does not use. Link rows show the address, not a preview: the app fetches nothing from third parties.
- The app has no push notifications and no background activity: a run continues on the server while the app is away, and the chat catches up when reopened.
- OpenRouter's shared capacity for `gpt-6.1-sol` rate-limits often; adding your own OpenAI key in OpenRouter's settings (BYOK) avoids that.

---

## Roadmap

Roughly in priority order. Move items to **Status** when done.

**From the hosted instance's first day on Claude (evaluated 2026-10-08): all six items were done on
2026-10-09. Still open from them: whether Jev's *routing* earns its keep on a weaker
model than Claude — it is off by default now and can be turned back on per instance — and a prompt
injection that actually reaches the risk filter or the provider's classifier in a live run.**

1. **Try the other models** — DeepSeek v4.1 Flash, Gemini 3.8 Flash: tool calls, forced tool choice, caching (Claude Haiku 5.5 directly: done 2026-10-08).
2. **Attachments, next steps** — broader document extraction/OCR, attachment retention controls, voice/video input, and live-provider compatibility coverage.
3. **Proactivity, next steps** — **script-fed Home widgets** (decided 2026-10-04, not built): a widget may carry a refresh command and an interval, the heartbeat runs it through `Computer.exec` with no model call and its output becomes the widget body; the user approves each command once, and a changed command asks again. This amends "a tick with nothing due is free" and needs its own gate beside the risk filter. After that, phone-side sources (HealthKit) writing through the widget API. Also: validate the Home brief with real models (stale-widget refreshes, note quality, cost per day) and on a phone; validate heartbeat interest discovery, sharing timing, aliases, novelty and costs with real models; a Tasks screen in the app with add / edit / complete; repeating follow-ups as a first-class field instead of the agent re-scheduling; a check-in on server start for anything overdue.
4. **Durable runs, next steps** — persist run events so a re-attach after a restart can replay a step's stream as it was; steering (see 14) on top of stored runs.
5. **Cache-friendly compaction** — summarise by appending an instruction to the existing (cached) conversation instead of sending a re-rendered transcript at full price.
6. **Web search, next steps** — put the Sunnie gateway in front of Exa (a metered, capped token per instance instead of the Exa key); watch real traffic for how often `web_fetch` needs the crawler, and whether the router picks `web_search` over the browser for searches; try the fallback live against a site that blocks datacenter addresses.
7. **Browser, next steps** — in the take-over sheet, pinch to zoom and drag to scroll the page (today: a zoom button and scroll keys); a screenshot of a chosen element or region rather than the whole window.
8. **Semantic recall, next steps** — the same embeddings for `memory_search`, for the duplicate check in `memory_save` (it misses paraphrases) and for passages of earlier conversations; a similarity floor so that unrelated memories stay out (needs real data to set); `sqlite-vec` or similar only if a store outgrows comparing every vector.
9. **Approvals, next steps** — a push notification when a run is waiting, "always allow this" rules, tune the threshold on real traffic.
10. **Router tuning** — Jev routing is opt-in since 2026-10-09; before turning it on for a model, log its decisions against what the model did on its own (`route-probe.mjs`), tune the thresholds (routing, remembering, recall) on real traffic, pin a Jev version. The Jev/Luna fixture comparison is complete (2026-10-07); next validate on held-out production traces, especially file uploads through submit buttons, before changing models or thresholds.
11. **Memory upkeep** — background consolidation: merge duplicates, retire stale facts.
12. **Sandbox computer** — a separate container (agent gets root) or remote VM behind the same `Computer` interface for work that needs system privileges; user-space package installation is available through Micromamba now.
13. **Helpers, next steps** — show each helper's progress in the app (the `subagent.*` events and `GET …/helpers` are there); a cheaper default model for helpers once one is benchmarked; tune `concurrency` against provider rate limits.
14. **Steering, next steps** — interrupt the step in progress when the message calls the work off; show waiting messages to other clients (`pendingMessages` on the run).
15. **Drive, next steps** — confirm on-phone automatic previews, revision-aware caching and sharing,
    validate the other app flows and live-model defaults; consider larger streamed transfers,
    file search, recoverable deletion and references that survive moves.
16. Multi-user / several agents per host.
17. **iOS interface validation** — review the refined screens on a physical iPhone and iPad,
    exercise VoiceOver and the remaining accessibility sizes, verify WhatsApp draft fidelity
    in the installed app (including emoji), verify reading older messages while a reply streams
    and catch-up after a suspended connection; verify new-chat model defaults on a phone, and rerun the app tests when requested.
18. **Skills, next steps** — deliberate version updates, private repository authentication, and
    live-model coverage of skill selection, self-authorship and service sign-in workflows.
19. **Ubuntu deployment validation** — exercise both installers on fresh amd64 and arm64 VPSs,
    including native browser use, reboot, reruns, failed downloads and existing Docker setups.
20. **Landing page, next steps** — the GitHub link once the repository is public; a real price.
21. **Notifications, next steps** — try delivery through Apple with the team's APNs key and on a
    physical iPhone; a push relay on the gateway so self-hosted servers can notify the App Store app
    (only the key holder can); clear an approval notification once it is answered elsewhere.
22. **Phone data, next steps** — try it on a phone with real Health history (read time, upload
    size, which types arrive); how often iOS actually runs the background refresh and HealthKit
    wake-ups on a phone (the simulator runs neither; Health is unreadable while the phone is locked); Health-derived Home widgets; copying chosen photos (or a day's) into Drive so Sunnie can look at them; writing back (add an event
    or a reminder, through an approval); running Ask Sunnie from a real automation; health records and medications (special
    entitlements); App Store review of sharing Health data with a server and a model provider.
23. **One chat, next steps** — it is the default now, and the hosted app's only mode; send the share
    extension and the Ask Sunnie shortcut into the one chat (they still start new conversations, which
    the hosted app has no list to show);
    try it on a phone over a long thread (compaction, "load earlier", scroll position).
24. **From the use-case tests (2026-10-05), what is left** — see `api/bench/results/2026-10-05/`
    (`usecases.md`, `usecases.after-fixes.md`, `usecases.work.md`). All five tabs of the landing page
    have now been run. (a) Drafts stay in the chat: the page says a teacher's quiz or lesson plan is
    saved to Drive, and it is not unless asked — change the copy or teach Sunnie to save documents.
    (b) A summary sentence contradicted its own correct table (vendor quotes): consider having
    comparisons computed rather than read. (c) The router's "remember" question saves transient
    things (this week's reminder list); a weekly follow-up drifts to the hour its check-in ran.
    (d) The approval row and the new upload on a phone; the SVG plot and long tables in the app.
    (e) Real sites: a school system, an HR portal with SSO, a file upload that sends at once.
25. **Mac app, next steps** — run `MacSmokeUITests` end to end (it stopped at macOS's UI-testing
    permission); look at every screen on a real Mac (forms, sheets' sizes, the sidebar with many
    conversations, widgets at Mac widths); the share extension from Finder and Safari; notifications
    through APNs to a Mac; the Ask Sunnie action in the Mac's Shortcuts; device data's permission
    prompts and the 15-minute sends; whether iPhone and Mac sharing the same source should be told
    apart on the server (one copy per source today: the last sender wins, and turning a source off
    on either deletes it).

---

## Quick start

For a VPS, use one of the [Ubuntu installers](#ubuntu-vps-installation) below.
Local development requires Node ≥ 24 and pnpm; run these commands from `api/`:

```bash
cd api
pnpm install
cp .env.example .env        # set SUNNIE_API_KEY and OPENROUTER_API_KEY
pnpm dev
```

```bash
# create a conversation, then talk to it
curl -s -X POST localhost:8787/v1/conversations -H "authorization: Bearer $SUNNIE_API_KEY"
curl -N -X POST localhost:8787/v1/conversations/<id>/messages \
  -H "authorization: Bearer $SUNNIE_API_KEY" -H "content-type: application/json" \
  -d '{"text":"What can you do on your computer?","timezone":"Asia/Jakarta"}'
```

Run locally like this and the agent's "computer" is a folder on your machine (`data/workspace`),
running as you. That is fine for development; **deploy with Docker** for real isolation:

```bash
docker compose up --build -d
```

The container is the agent's computer. `/var/lib/sunnie` holds the database and optional
`config.json` (root only); `/home/sunnie` is the agent's home.

### Ubuntu VPS installation

Choose **one** installer from the repository root. Both support Ubuntu 22.04, 24.04 and
26.04 LTS on amd64/arm64, with systemd and outbound HTTPS access. Installation needs root
or sudo. They prompt for an OpenRouter key (input hidden) and an optional model spec; pressing
Enter for the model keeps the repository default. They generate a random app key, start the
service, and check an authenticated `/v1/info` response before reporting success. They do not
make a model request, install a tunnel, or change firewall rules.

Create a dedicated Linux user and clone the repository as that user. For example, from your
administrator account (replace the repository URL):

```bash
sudo adduser sunnie
sudo -iu sunnie
git clone <your-sunnie-repository-url> Sunnie
exit
```

Then run either installer as the administrator:

```bash
# Docker mode
sudo bash /home/sunnie/Sunnie/install-docker.sh

# Or native mode: the agent uses the existing Linux user directly
sudo bash /home/sunnie/Sunnie/install-native.sh --user sunnie
```

If the account holding the clone already has sudo access, `bash install-docker.sh` or
`bash install-native.sh` from the clone also works; the scripts request sudo themselves.
Native mode defaults to that invoking account, or takes an explicit `--user`.

**Docker mode** installs Docker Engine, Buildx and Compose if missing, using Docker's
[official Ubuntu apt repository](https://docs.docker.com/engine/install/ubuntu/).
It reuses a complete Docker installation and stops with guidance on conflicting packages or
repository settings. It builds the existing Sunnie Dockerfile and uses a fixed Compose project
name, `sunnie-vps`, so renaming or moving the clone does not change the volumes. The container
starts after reboot through Docker and its `unless-stopped` restart policy. Host Node/pnpm are
not needed. The installer does not add the login user to the Docker group.

**Native mode** installs a private [Node 24 runtime](https://nodejs.org/en/download/archive/v24),
the pnpm version pinned in `api/package.json`, locked production dependencies, Chrome, Xvfb,
the existing browser workaround and Micromamba. Node downloads are checked against upstream
SHA-256 checksums; Micromamba uses the same pinned digests as the Dockerfile. Package lifecycle
scripts are disabled for the native dependency install. Node/npm/pnpm/Micromamba are made
available in the agent's `~/.local/bin`; unrelated tools already at those paths are preserved
and cause the installer to stop with instructions.

The native systemd service runs the server as root and drops to the selected user for every
agent command, using the existing `LocalComputer` boundary. A root-owned copy of the server
lives under `/opt/sunnie`; it never runs the writable clone as root. The unit sets
`NoNewPrivileges=true` to prevent commands gaining privileges through setuid executables.
Use a dedicated account with no Docker socket access or other administrative service access.
Native commands can access whatever that account can access on the VPS; Docker supplies an
additional container boundary. The user's home must be a normal directory under `/home`.

#### Connect through your tunnel

Both modes listen only at **`http://127.0.0.1:8787`** on the VPS. Point your HTTPS tunnel there,
then enter the tunnel's HTTPS URL and the app key into Sunnie's connect screen. Retrieve the
key as the administrator:

```bash
sudo sed -n 's/^SUNNIE_API_KEY=//p' /etc/sunnie/sunnie.env
```

For a temporary connection from a laptop, run this on the laptop:

```bash
ssh -N -L 8787:127.0.0.1:8787 YOUR_SSH_USER@YOUR_VPS
```

That makes Sunnie available at `http://127.0.0.1:8787` on the laptop. For the iPhone, use a
tunnel URL reachable from the phone; the laptop's localhost is not the phone's localhost.

#### Operations and updates

| | Docker | Native |
| --- | --- | --- |
| Logs | `sudo docker compose -p sunnie-vps -f /opt/sunnie/docker/docker-compose.yml logs -f --tail 100` | `sudo journalctl -u sunnie -f` |
| Stop | `sudo docker compose -p sunnie-vps -f /opt/sunnie/docker/docker-compose.yml stop` | `sudo systemctl stop sunnie` |
| Restart | `sudo docker compose -p sunnie-vps -f /opt/sunnie/docker/docker-compose.yml restart` | `sudo systemctl restart sunnie` |
| Database/config | Volume `sunnie-vps_sunnie-data`, mounted at `/var/lib/sunnie` | `/var/lib/sunnie` |
| Agent files | Volume `sunnie-vps_sunnie-home`, mounted at `/home/sunnie` | Selected user's home |

Credentials live in `/etc/sunnie/sunnie.env`, owned by root with mode `0600`, in both modes.
They are preserved on reruns and never copied from a development `.env`. Edit this file with
`sudoedit` to change keys or `SUNNIE_MODEL`, then rerun the installer (a plain Docker restart
does not reload environment changes). Keep entries as unquoted `NAME=value` lines. Runtime
paths, the agent user and bind settings belong to the deployment, not this credentials file.
Optional application settings remain in `/var/lib/sunnie/config.json` inside the data volume
or native data directory; the installer leaves that file alone.

To update, pull the repository as the clone's owner, then rerun the same installer with the
same native user. It installs the checked-out revision and restarts Sunnie while retaining
the app key, database, Drive, browser profile, skills and package environments. Back up the
data and home before upgrading. Previous deployment copies and native runtimes remain under
`/opt/sunnie/releases` and `/opt/sunnie/runtimes`; the installer does not prune them. Failed
installation keeps data for a rerun, but does not automatically roll back a started upgrade.
Do not remove Docker volumes to update.

These scripts create one instance per VPS. They refuse to switch an existing install between
modes automatically; each mode has different data locations. They also do not import a prior
manual deployment or the `api-sunnie` volumes used by the development Compose setup.

### Installing software on Sunnie's computer

The Docker image includes [Micromamba 2.9.0](https://github.com/mamba-org/micromamba-releases/releases/tag/2.9.0-0)
for Linux ARM64 and x86-64, pinned to upstream SHA-256 digests. Agent commands receive
`MAMBA_ROOT_PREFIX=$HOME/.local/share/mamba`, so environments and downloaded packages live in
the existing `sunnie-home` volume and survive container replacement. Local development uses
the same directories, but requires installing Micromamba separately if wanted.

Sunnie installs prerequisites through its ordinary `bash` tool and approval gate. For example,
on the agent's computer (or ask Sunnie to do it in chat):

```bash
micromamba env list
# Create once; use "install" instead of "create" to add packages to an existing environment.
micromamba create -y -n tools --override-channels -c conda-forge tree
micromamba run -n tools tree --version
```

Use `micromamba run` on every call: shell activation does not survive into the next tool call.
Separate named environments can hold incompatible dependencies. The prompt asks Sunnie to
reuse existing environments, allow enough time for package downloads, verify a real command,
and record verified prerequisites when writing a skill. Helpers reuse environments and report
missing software to the main agent instead of modifying shared environments concurrently.
No installed-package catalog is inserted into the system prompt or tool definitions.

`~/.local/bin` is prepended to `PATH` after login profiles run, even in an existing home volume.
`NPM_CONFIG_PREFIX=$HOME/.local` keeps global npm installs there. Python virtual environments
and compatible standalone downloads are also supported. No sudo access or new API route is
needed; server credentials remain absent from the command environment. Retain the home volume
when rebuilding Docker, and do not use `docker compose down -v` unless its data should be lost.

### The iOS app

`app/Sunnie/Sunnie.xcodeproj` (Xcode 27, iOS 26+, iPhone and iPad). Open it, run on a simulator or
device, enter the server's address (`http://<your-mac's-LAN-IP>:8787` when running `pnpm dev` with
`SUNNIE_HOST=0.0.0.0`) and the `SUNNIE_API_KEY`. The key is stored in the Keychain. Every server
that connects is saved; switch between them under Settings → Servers.

```bash
cd app/Sunnie && xcodebuild test -scheme Sunnie -destination 'platform=iOS Simulator,name=iPhone 17'
```

**Signing your own build.** The simulator needs no Apple account: open the project and run. For a
device, copy `app/Sunnie/Signing.local.example.xcconfig` to `Signing.local.xcconfig` (gitignored) and
set your team ID and a bundle ID prefix you control; the app becomes `<prefix>.Sunnie` and its share
extension `<prefix>.Sunnie.Share`. A device build needs a paid Apple Developer Program membership,
because the app uses push notifications, HealthKit and a Keychain group shared with the extension.
For notifications from your own server to your own build, set `push.apns.topic` to your app's
bundle ID and use an APNs key from your team.

The UI smoke test needs a running server whose model is the scripted fake provider; see
`app/Sunnie/SunnieUITests/SmokeUITests.swift` for the environment variables.

The look is deliberately quiet: system iOS styling, always light, tinted leaf green, with the
sunflower logo only on the connect screen, in empty states and as the "working" star. The logo,
icon and launch image are in `Sunnie/Assets.xcassets`; the brand pieces in `Sunnie/Design/`.

**The App Store build (hosted flavor).** `SUNNIE_FLAVOR` in `Signing.xcconfig` picks the app:
`selfhosted` (the default, everything above) or `hosted`, for people on the hosted service, who sign in
with the code from its panel and see no models, servers or server details. `SUNNIE_CONNECT_HOST` is the
panel's host name, where a typed code is claimed (`https://<host>/c/<code>`). Set both in
`Signing.local.xcconfig`, or per build:

```bash
cd app/Sunnie && xcodebuild archive -scheme Sunnie -destination 'generic/platform=iOS' \
  -archivePath build/Sunnie.xcarchive SUNNIE_FLAVOR=hosted SUNNIE_CONNECT_HOST=panel.example.com
```

### The Mac app

The same Xcode project and scheme: choose **My Mac** as the destination (macOS 26+). It is the iOS app's
target built for macOS, so a change to a screen reaches both; Mac-only pieces live in `Sunnie/Mac/`
(the sidebar window and menu commands) and the few platform differences in `Sunnie/Design/Platform.swift`.

```bash
cd app/Sunnie && xcodebuild test -scheme Sunnie -destination 'platform=macOS' -only-testing:SunnieTests CODE_SIGNING_ALLOWED=NO
```

Unsigned builds are enough for the unit tests (their host app opens a window while they run). To run
the app itself — sandboxed, with the Keychain group shared with the share extension and push — it must
be signed by your team (`Signing.local.xcconfig`, as for an iPhone build; Xcode makes a Mac development
profile). `SunnieUITests/MacSmokeUITests.swift` is the Mac counterpart of the iOS smoke test; it takes
over the mouse and keyboard while it runs and needs Accessibility permission for UI testing.

## Configuration

Secrets come from the environment (`.env`); everything else from an optional
`$SUNNIE_HOME/config.json` — see [`sunnie.config.example.json`](sunnie.config.example.json).
Every field has a default (`src/config.ts` is the reference).

| Env var | Purpose |
| --- | --- |
| `SUNNIE_API_KEY` | **Required.** Bearer token clients must send. |
| `OPENROUTER_API_KEY` | The default inference endpoint. Also reaches Jev when no TypeSafe key is set — this one key runs everything. |
| `TYPESAFE_API_KEY` | Optional. Call Jev (the tool router) through TypeSafe's own API instead of OpenRouter. |
| `EXA_API_KEY` | Optional. Turns on web search (`web_search`) and the crawler fallback of `web_fetch`, through [Exa](https://exa.ai). The server holds it; the agent never sees it. |
| `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY` | Optional direct provider access, for specs like `openai/…` or `deepseek/…`. |
| `SUNNIE_MODEL` | Default model, e.g. `openrouter/openai/gpt-6.1-sol`, `openrouter/deepseek/deepseek-v4.1-flash`. |
| `SUNNIE_HOME`, `SUNNIE_HOST`, `SUNNIE_PORT` | Data directory (`./data`), bind address (`127.0.0.1`), port (`8787`). |
| `SUNNIE_WORKSPACE`, `SUNNIE_COMPUTER_USER` | The agent's home directory, and the Linux user its commands run as (server must be root). |
| `SUNNIE_APNS_TEAM_ID`, `SUNNIE_APNS_KEY_ID`, `SUNNIE_APNS_KEY` (or `SUNNIE_APNS_KEY_PATH`) | Optional. Turns notifications on: the Apple team, the APNs key's id, and the `.p8` key itself (its text, line breaks may be written `\n`) or a path to it. The key must belong to the team that signs the app. |

Config sections:

- `agent` — `defaultModel`, `reasoning` (`none` … `xhigh`; default `medium`; on an `anthropic/…` model `none` and `minimal` mean the least thinking, `low`, since current Claude models cannot turn it off, and `temperature` must stay unset), `turnBudgetTokens` (unset; an advisory token budget for one turn, told to a model that takes one — Anthropic's task budget — so it paces itself and winds down instead of being cut off; minimum 20,000), step limit, retry policy, `maxAttempts` (3: how many different ways around an obstacle the agent tries before it stops and reports; stated in its system prompt), `stallTimeoutMs` (150,000: a model call that sends nothing for this long is given up on, and retried if it had produced nothing; twice as long at `high`/`xhigh` reasoning and for the summariser).
- `models` — per model spec: `contextWindow`, `maxOutputTokens` (an `anthropic/…` model defaults to 16,000, thinking included), `advisor` (`{ model, maxUses?, maxTokens? }`, Anthropic only: a stronger model the agent may consult mid-step, run by the provider and paid at that model's price; the prompt gains a section saying when to ask it), `reasoning`, `media: { images?, pdf? }` (disable native parts for a model that does not support them; originals and extracted text remain usable), `steer` (`tool-choice`, or `hint` for a provider that accepts no imposed tool choice — a model is switched to `hint` by itself the first time its provider refuses), and free-form `providerOptions` passed to the provider (e.g. OpenRouter's `provider.order` to pin an upstream).
- `providers` — add any OpenAI-compatible endpoint, or override a built-in.
- `router` — `type` (`jev` / `none`; default `none` since 2026-10-09: the model picks its own tools, and the endpoint and key here still serve the risk filter and the recall filter), `confidenceThreshold` (0.7), `replyThreshold` (0.8: what a decision to reply, which ends the turn, needs instead; below it the model decides), `rememberThreshold` (route to `memory_save` when Jev's probability that the message is worth remembering reaches it; 0.7, `1` = never ask), `mode` (`tool-choice` / `active-tools`).
- `memory` — `recallLimit` (most memories attached to a message; 6), `recall`: `type` (`jev` / `none`; default `none` since 2026-10-09: every message gets its nearest memories), `threshold` (recall when Jev's probability that the message needs it reaches this; 0.5), `timeoutMs`. Uses the router's endpoint, key and `model`, and works with `router.type: "none"`. `embedding`: `model` (`<provider>/<embedding-model-id>` for recall by meaning, default `openrouter/voyageai/voyage-4-lite`; `"none"` for keywords; providers of type `openrouter`, `openai`, `google` and `openai-compatible` have embedding models), `timeoutMs` (3000). Changing the model re-embeds every memory at the next start. Also `coreBlockLimit`.
- `approvals` — `type` (`jev` / `none`), `threshold` (hold a call when Jev's risk probability reaches it; 0.5), `onError` (`ask` / `allow` when Jev cannot judge; `ask`), `timeoutMs`, `providerCheck` (default on: on an `anthropic/…` model, ask the provider's dangerous-tool-use classifier about every call too, and hold what it flags). Uses the router's endpoint, key and `model`, and works with `router.type: "none"`.
- `usage` — `url` (a GET the hosting service answers with `{ used, limit, resetsAt? }`, tokens for the month), `apiKeyEnv` / `apiKey` (the bearer token for it), `timeoutMs` (5000). Set by the hosted panel; unset, `/v1/usage` is 404 and `/v1/info` says `usage: { enabled: false }`.
- `heartbeat` — `enabled` (default on), `intervalMinutes` between looks at the follow-up list (10), `recheckMinutes` before a follow-up whose check-in failed is tried again (60), `maxTasksPerRun` (10), `approvalWaitMinutes` (15: a check-in that has waited this long for a go-ahead gives way once another follow-up is due — the request counts as unanswered, and what it was woken for comes back after `recheckMinutes`), `interestMinutes` (240: a followed topic is looked at no more often than this), `model` for check-in runs (default: the default model). With it off the agent has no task tools.
- `subagents` — helpers for parallel work: `enabled` (default on; off removes the `delegate` tool and its prompt section), `maxTasks` per `delegate` call (10), `concurrency` — helpers at work at once (5), `maxSteps` per helper (15), `maxReportChars` per report (6,000), `model` for helpers (default: the model of the turn that sent them).
- `search` — `type` (`exa` / `none`), `baseURL` (`https://api.exa.ai`, or a gateway that speaks the same API), `apiKeyEnv` (`EXA_API_KEY`), `defaultResults` (5; the model may ask for 1–10), `fetchFallback` (on: `web_fetch` reads a page through Exa when the site refuses it), `timeoutMs` (20,000).
- `browser` — `enabled` (default on), `headless` (default off: Chrome runs with a real window, on a virtual screen from Xvfb where the computer has no display; on your own desktop the window is visible), `executablePath` (a specific browser binary; unset means the installed Google Chrome, then Chromium), `browsersPath` (where Playwright's Chromium, the fallback, is installed; also read from `PLAYWRIGHT_BROWSERS_PATH`), `idleMinutes` before the browser is closed (30), `maxOutputChars` per page outline (12,000).
- `push` — `apns: { teamId, keyId, keyPath?, keyEnv (SUNNIE_APNS_KEY), topic (com.yoursunnie.Sunnie; must be the bundle ID of the app you install), timeoutMs (10,000) }`. Absent: notifications are off and `/v1/info` says `push: { enabled: false }`; devices still register, so notifications start once a key is added.
- `compaction`, `computer`.
- `skills` — `enabled` (default on); `command` optionally overrides the bundled skills client
  when using a remote `Computer`. Skill files belong to the agent's persistent home, not the
  server data directory. No repository is trusted by default.

A model spec is `<provider>/<model-id>`; everything after the first slash goes to the provider
untouched, so OpenRouter models read `openrouter/openai/gpt-6.1-sol`.

---

## API

All `/v1` routes need `Authorization: Bearer <SUNNIE_API_KEY>`. Errors are
`{ "error": { "code", "message" } }`. JSON requests are limited to 1 MiB; the raw original upload allows 20 MiB and an image rendition allows 5 MiB. Oversized bodies receive `413` (`payload_too_large`).

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness (no auth) |
| `GET /v1/info` | Name, version, default model, providers, router, `approvals: { type }`, `usage: { enabled }` (whether `GET /v1/usage` answers), computer, `browser: { enabled }`, `heartbeat: { enabled, intervalMinutes }`, `subagents: { enabled, maxTasks, concurrency }`, `quoting: { enabled: true }`, `interests: { enabled }` (whether heartbeat discovery is enabled), `home: { enabled, brief, briefHour, widgetTypes }` (`widgetTypes`: the widget node types this server accepts), `push: { enabled }` (whether the server can send notifications), `phone: { enabled, sources }` (the phone sources this server accepts), `greeting: { pending, introducing }` (`pending`: nobody has met the user, no message typed and no greeting yet, so the app starts one; `introducing`: the introduction that follows is going on, so the app shows only the chat). The name is always `Sunnie`. |
| `GET /v1/usage` | How much of the month's allowance the hosting service gives this server is used: `{ used, limit, percent, resetsAt? }` (tokens; `percent` 0–100, one decimal). `404` when no service is configured, `502` when it cannot be reached. The app shows it as a bar in Settings. |
| `GET` / `PATCH /v1/settings/model` | Read/save `{ model, reasoning }` defaults for new chats. `model` is a full Sunnie spec; mobile accepts an OpenRouter author/model ID and supplies the provider prefix. Effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Both fields are required on PATCH. Validates syntax and provider configuration without a paid model call. Saved in SQLite; existing chats and automatic check-ins keep their configuration. `/v1/info` advertises `modelSettings: { enabled: true }` and `newChatDefaults: { model, reasoning }`; `defaultModel` remains the server-configured fallback. |
| `GET /v1/skills` | Authenticated installed catalog: `{ skills: [{ name, description, path, bundled, enabled }], warnings: string[], sources: [{ repository, trustedAt }] }`. `bundled`: shipped with Sunnie; `enabled`: offered to the agent (always `true` for the agent's own skills; a shipped skill starts `false`). Lists every skill, on or off. `/v1/info` also includes `skills: { enabled }`. |
| `PATCH /v1/skills/:name` | `{ enabled: boolean }`: turn a skill shipped with Sunnie on or off. Returns its catalog entry. `404` for a name that is not a shipped skill (the agent's own are always on). |
| `DELETE /v1/skills/sources?repository=<encoded HTTPS URL>` | Revoke repository trust. Leaves installed files intact; a later installation from the repository requires approval again. |
| `GET /v1/drive/entries?path=&offset=0` | List a Drive folder: `{ path, entries, nextOffset }`, 200 entries per page. Empty path is the root. |
| `GET /v1/drive/entry?path=…` | Metadata: `{ path, name, kind, sizeBytes, modifiedAt, revision, mediaType }`. `kind` is `file`, `directory`, or `unsupported` in listings. |
| `GET /v1/drive/content?path=…` | Authenticated current file download, up to 20 MiB; attachment disposition and no-store/nosniff headers. Returns `X-Drive-Revision`; optional `revision` query returns `409` if the bytes read belong to another revision. |
| `POST /v1/drive/content?path=…` | Create a file from raw bytes, up to 20 MiB. Never replaces an existing item; returns metadata and `201`. Parent folder must exist. |
| `POST /v1/drive/folders` | Create a folder, body `{ path }`; returns metadata and `201`. |
| `GET /v1/drive/text?path=…` | `{ entry, text }` for UTF-8 text up to 256 KiB. |
| `PUT /v1/drive/text` | Save `{ path, text, revision }`; returns fresh metadata. A changed revision returns `409`, preserving the server file. |
| `PATCH /v1/drive/entry` | Move or rename `{ path, destination, revision }`; returns `{ path }`. Destination must not exist and its parent must exist. |
| `DELETE /v1/drive/entry?path=…&revision=…` | Permanently delete a file or a folder including its contents; returns `204`. Root cannot be deleted or moved. |
| `POST /v1/attachments` | Upload raw bytes with `Content-Type`, `X-Filename` (percent-encoded UTF-8), and optional `X-Request-ID`. Returns `{ id, filename, mediaType, sizeBytes, createdAt }`: `201` for a new upload, `200` for the same upload retried. Reusing the request ID with different bytes or metadata returns `409`. |
| `PUT /v1/attachments/:id/preview` | Optional immutable visual rendition for an image original: raw JPEG/PNG, at most 5 MiB. `201` when stored, `200` for identical retries, `409` for a differing replacement. The original download stays unchanged. iOS generates a JPEG rendition up to 2048 pixels for decodable formats such as HEIC; API clients may supply their own. |
| `GET /v1/attachments/:id` | Read attachment metadata. |
| `GET /v1/attachments/:id/content` | Download the authenticated original; no public file URLs. |
| `POST /v1/conversations` | Create. Body: `{ title?, model? }`. Snapshots the new-chat model/effort defaults. An explicit model uses its configured effort (or the agent fallback). Conversation DTOs add nullable `reasoning`. |
| `GET /v1/conversations` | List, newest first. `?limit&before`. Each has `kind`: `chat`, or `heartbeat` for the Check-ins conversation the agent's own check-ins are written to (it is otherwise an ordinary conversation: it can be read, written to, renamed and deleted). Each also has `parentId` (null). Helpers' transcripts are not listed here. |
| `GET` / `PATCH` / `DELETE /v1/conversations/:id` | Read, rename or change model, delete |
| `GET /v1/conversations/:id/messages` | History. `?limit&before_seq&after_seq` (pages back from the newest). `quiet=hide` leaves out quiet check-ins: runs the system opened, nobody typed in, whose last visible words were empty, `NOTHING_TO_SHARE` or "Nothing to report." (the active run never counts). `limit` counts what is returned. |
| `GET /v1/conversations/:id/cards` | What the user set in the interactive cards of the conversation's replies: `{ cards: [{ messageId, card, state, updatedAt }] }`. `state` maps each name to a number, text, true/false or (a checklist) a list of true/false. |
| `PUT /v1/messages/:id/cards/:card` | `{ state }`: save what the user set in card `card` (from 0) of an assistant message. Only names the card has, each of the kind and range its input allows (`400` otherwise); `404` for no such card. Sunnie is told what changed with the next user message in that conversation. |
| `GET /v1/conversations/:id/helpers` | The helpers sent from this conversation, oldest first: conversations with `kind: "subagent"` and `parentId` set, whose `title` is the task. Read one's transcript with `GET /v1/conversations/<helper id>/messages`; it starts with the task (role `user`) and ends with the report. A helper's conversation is read-only (`400` on send, rename, compact, delete) and is deleted with its parent. |
| `POST /v1/conversations/:id/messages` | Send a message and start a run. Body: `{ text?, attachmentIds?, quotes?, model?, timezone?, stream?, wait?, requestId? }`. At least text, an attachment or a quote is required. Answers with an SSE stream, or JSON if `stream: false`. With `stream: false, wait: false`, returns `202 { run, messages: [] }` as soon as the run is accepted, suitable for share extensions. `409` if a run is active. `requestId` is the client's own id for this send (up to 200 characters): sending again with the same one in the same conversation answers with the run the first send started — still going or long finished — and starts nothing. |
| `POST /v1/conversations/:id/compact` | Compact now (`502` if the summariser model fails) |
| `GET /v1/runs/:id` | Run status, with `pendingApprovals: [{ toolCallId, name, input, target? }]` — the tool calls waiting for an answer. Also answers for a run that ended before a restart. |
| `GET /v1/runs/:id/events?after=<seq>` | Re-attach to a run's SSE stream (also honours `Last-Event-ID`). The full stream is kept for 10 minutes after the run ends; later, or after a restart, the stream is rebuilt from what was stored: `run.started`, the run's `message` events, and its terminal event. |
| `POST /v1/runs/:id/cancel` | Stop a run |
| `POST /v1/runs/:id/messages` | Say more to a run that is at work. Body: `{ text?, attachmentIds?, quotes?, timezone?, requestId? }` (text, attachments or quotes required). `202` with the run; the message joins the run between two steps and then arrives on the run's stream as a `message` event with role `user` (several waiting ones arrive as one message, texts joined by a blank line, within attachment and quote limits). `409` once the run is over — send it as an ordinary message then. A repeated `requestId` is accepted and queued once. |
| `POST /v1/runs/:id/approvals/:toolCallId` | Allow or deny a held tool call. Body: `{ approved: boolean }`. `404` if that call is not waiting (already answered, or the run is over). |
| `GET /v1/browser/handoff` | The browser hand-off going on, if any: `{ handoff: { id, status, reason, conversationId, runId, toolCallId, startedAt, takenAt } \| null }`. `status` is `requested` while the agent waits for the user to take the browser (`reason`: what it wants done on the page), `active` while the user holds it. A hand-off the user began on their own has `reason`, `conversationId`, `runId` and `toolCallId` null. One at a time: there is one browser. |
| `POST /v1/browser/handoff` | Take the browser: the agent's pending request becomes `active`, or a hand-off of the user's own begins. Body `{}`. Taking it again is harmless. `409` when the browser is turned off. `/v1/info` says `browser: { enabled, handoff }`. |
| `GET /v1/browser/handoff/screen` | The page as the user holds it: a JPEG of the viewport, with `X-Screen-Width`, `X-Screen-Height` (its size in CSS pixels), `X-Page-Url` and `X-Page-Title` headers (the last two percent-encoded). Optional `?width=&height=` (both or neither, `400` otherwise): the size the app shows the page at, in points; the page is laid out for it (320–1280 wide) until the agent's next browser command, which gets its 1280×900 window back. Without them the viewport stays as it is (1280×900 unless the app sized it). When a text field on the page has the focus, `X-Focus-Secret` (`1` for a password, else `0`) and `X-Focus-Label` (what the page calls it, percent-encoded) say so, for the app to bring up its keyboard. `409` unless the hand-off is `active`; `502` when the browser could not be pictured. |
| `POST /v1/browser/handoff/input` | The user's touch or typing on the page, answered with the page afterwards like `screen`. Body one of `{ kind: "tap", x, y }`, `{ kind: "scroll", x, y, dx, dy }` (a mouse wheel at that point), `{ kind: "text", text, secret? }` (`secret: true` for a password: it is kept out of every outline the agent reads afterwards) or `{ kind: "key", key }` (`Enter`, `Tab`, `Backspace`, `Escape`, `ControlOrMeta+A`, …). Coordinates are pixels of the picture (CSS pixels of the viewport). `409` unless the hand-off is `active`. |
| `POST /v1/browser/handoff/end` | Hand the browser back. Body: `{ outcome?: "done" \| "declined", note? }` (`declined`: the user will not take it right now; works on a `requested` hand-off too). The waiting `browser_handoff` call then gets the page as the user left it (or the refusal). `204`; `404` when there is no hand-off. |
| `GET /v1/memories?q=&limit=&offset=` | List or search archival memory |
| `POST /v1/memories`, `PATCH` / `DELETE /v1/memories/:id` | Curate archival memory |
| `GET /v1/core-memory`, `PUT /v1/core-memory/:block` | Read / replace the `user` or `persona` block |
| `GET /v1/interests` | `{ paused, nextDigestAt, enabled, interests: [{ id, topic, status, memoryId, lastCheckedAt, createdAt }] }`. `status` is `active` or `muted`; `enabled` reflects heartbeat configuration. `nextDigestAt` is retained as null for compatibility: there is no independent digest schedule. `lastCheckedAt` and `memoryId` can be null where no value exists. |
| `PATCH /v1/interests/settings` | `{ paused: boolean }` → `{ paused, nextDigestAt }`. Pausing also cancels an automatic digest in progress. |
| `PATCH /v1/interests/:id` | `{ status: "active" or "muted" }` → the updated interest. Muting cancels an automatic digest containing that topic; `404` for an unknown ID. A digest that already took a real user message continues as an ordinary conversation. |
| `GET /v1/home?timezone=` | The Home screen: `{ timeZone, widgets, checkIns, brief }`. `widgets`: unexpired widgets in order, hidden ones included: `[{ id, title, body, action, columns, resizing, source, hidden, expiresAt, createdAt, updatedAt }]` (`columns`: 1 to 4 of Home's four; `resizing`: Sunnie is redesigning it for a width the user just picked; `title`: its name, not drawn). `source` is `agent` or `api` (`builtin` is retired: the app has no widgets of its own); `expiresAt` null stays until removed. `body` is one node (see **Home widgets** below); `action` is null or `{ type: "open_url", url }` (https), `{ type: "open_chat", conversationId }`, `{ type: "ask", prompt }` or `{ type: "open_file", path }` (a Drive path). `checkIns`: as below. `brief`: `{ enabled, running, lastAt, hour }`. A valid `timezone` is remembered for the daily brief (so is a send's `timezone`). |
| `GET /v1/check-ins` | `{ conversationId, latestSeq, latestAt, running }`: `latestSeq` is the newest check-in message with something to say (null if none); a client compares it with what it has shown to mark Check-ins as new. |
| `POST /v1/greeting` | Body `{ timezone? }`. Opens a new user's first chat, in which Sunnie speaks first: `202 { conversation, run }`, with the run already going (`conversation.activeRunId`). Its opener is a `user` message with `origin: "greeting"` that nobody typed; clients do not draw it. Later turns are ordinary messages to that conversation. `409` once anyone has written to Sunnie or a greeting has started, so a second device or a retry cannot greet twice. |
| `POST /v1/greeting/done` | Ends the introduction early (the user skipped it): `204`. Sunnie ends it herself with the `introduction_done` tool; it also ends after five typed replies or a day. |
| `POST /v1/home/brief` | Body `{ timezone? }`. Starts a Home brief now: `202 { run }`. `409` when briefs are off, a run is active in Check-ins, or a brief started less than 15 minutes ago. |
| `POST /v1/home/widgets/from-card` | Pin a reply's card to Home: `{ messageId, card, columns? }` (`card` is its place among the message's `widget` blocks, from 0). Its inputs start where the user left them, a `reply` becomes an `ask`, and the widget (id `card-…`) is answered with `201`. `404` for no such card. |
| `PUT /v1/home/widgets/:id/state` | `{ state }`: what the user set in a widget's interactive parts, checked against them (`400` otherwise). Widgets carry it as `state` (null while untouched); a new design keeps it only while it still fits. |
| `PATCH /v1/home/widgets/:id` | Refresh a widget's data and nothing else. Body `{ values, title?, hours? }`: `values` maps a part's `key` to its new data fields (see **Home widgets**); `hours` restarts its expiry (omitted: unchanged). Its design, width, place, tap and whether it is hidden stay. Answers the widget; `400` for an unknown key or a field that is design, `404` if there is none. |
| `POST /v1/home/widgets/:id/resize` | The user picked a new width on Home. Body `{ columns, timezone? }`. The width applies at once, and a quiet run in Check-ins (at most 3 steps, `home_widget` "set" on this widget only, at this width) has Sunnie redesign it for the new size, keeping its look. Answers `202 { widget, run }`; the widget is `resizing: true` in `GET /v1/home` until that run ends. `409` if it is already that wide or Sunnie is busy with Home (a brief or a check-in), `404` if there is no such widget. |
| `PUT /v1/home/widgets/:id` | Write a widget whole. Body `{ body, title?, action?, hours?, before?, columns? }`: `title` is the widget's name for menus and quotes — it is not drawn; a heading is part of the body (omitted: a known id keeps its name); `columns` is 1 to 4 (omitted: a known id keeps its width, a new one is 4); `id` is lowercase letters, digits, `-`, `_` (at most 40); `hours` makes it expire (omitted: it stays); `before` is the id it goes above (omitted: a known id keeps its place, a new one goes last). Answers the widget. `400` with an explanation for a body that is not valid, or past 40 widgets. |
| `DELETE /v1/home/widgets/:id` | Take a widget off Home: `204`; `404` if there is none. The same id written again within 14 days returns to its place. |
| `PUT /v1/home/layout` | The user's arrangement. Body `{ order?, hidden? }`: `order` lists ids top to bottom (ids left out keep their order, below); `hidden` is the full set of hidden ids. Answers `{ widgets }`. |
| `GET /v1/tasks?status=&limit=` | The agent's follow-ups, read-only: `{ id, content, status, note, dueAt, checks, timeZone, conversationId, createdAt, updatedAt }`. `status` is `open` or `done`; `dueAt` null means "at the next check-in"; `checks` counts the check-ins that woke the agent for it. |
| `GET /v1/phone` | What the phone has shared: `{ sources: [{ source, capturedAt, updatedAt, count }] }` (`count`: events, reminders, contacts, stays, songs or photos, or for health the kinds of data). |
| `PUT /v1/phone/:source` | Replace one source's snapshot. `source` is `health`, `calendar`, `reminders` or `location`; also `contacts`, `places`, `music`, `photos`; body `{ capturedAt, timeZone?, data }` with `data` in the shape of `api/src/phone/phone-store.ts` (`PHONE_SCHEMAS`). Up to 8 MB. Answers the source's status; `400` says what is wrong and keeps the last good snapshot. |
| `DELETE /v1/phone/:source` | Delete what the phone shared for a source: `204`, also when there was nothing. |
| `POST /v1/devices` | Register this device for notifications. Body `{ token, environment }`: the APNs token as lowercase hex, `environment` `sandbox` (debug builds) or `production`. Registering again updates it. Answers `{ token, environment, pushEnabled }`. |
| `DELETE /v1/devices/:token` | Stop notifications to a device: `204`, also when it was not registered. |
| `GET /v1/logins` | Saved logins: `{ id, name, site, username, hasPassword, hasTotp, createdAt, updatedAt }`. Passwords and code secrets are never returned. |
| `POST /v1/logins` | Save one. Body: `{ site, name?, username?, password?, totpSecret? }`. `site` may be a host or a URL; `name` defaults to the site and must be unique (`409`); `totpSecret` is the base32 setup key or an `otpauth://` link. |
| `PATCH` / `DELETE /v1/logins/:id` | Edit (omitted fields keep their value; `""` clears a secret) or delete |

**Run events** (SSE `event:` name; `data:` is JSON carrying the same `type` and a `seq`):

| Event | Payload |
| --- | --- |
| `run.started` | `runId`, `conversationId`, `model` |
| `message` | A persisted message: `{ id, conversationId, seq, role, text, origin, parts[], attachments?, quotes?, model, runId, createdAt }`. `origin` is `"heartbeat"` on the `user`-role opener of a check-in and on assistant messages from automatic interest discovery, `"greeting"` on the hidden opener of a greeting; otherwise null. Nobody typed an opener with an origin. Quiet discovery replies have empty `text` and no text parts; actual findings arrive in the persisted message without preceding `text.delta` events. For assistant messages `model` is the model that actually answered. |
| `route` | The router's decision for the next step: `decision` (`tool` / `respond` / `auto`), `tool?`, `confidence?`, `reason?` (`low-confidence`, `error`, `disabled`, or `repeat` when the router picked the tool the previous step had just used, `after-failure` when it wanted to end the turn right after a failed tool call). After a `respond` decision a tool call is refused with an error result instead of being run; `not-followed` marks the rest of a turn in which the model could not be steered. Repeats if the step is retried. |
| `text.delta`, `reasoning.delta` | `text` |
| `tool.call` | `toolCallId`, `name`, `input` |
| `tool.approval.requested` | The call is held until answered: `toolCallId`, `name`, `input`, `review?` (for `skill_install`: `{ summary, caution, checked }`, what the skill is, why it was chosen, what it helps with and what it can reach, in plain Markdown, and whether the Jev screen found it unsuitable, harmful or untrustworthy; `reason: "skill-caution"` when that alone holds the call), `target?` (for a browser call that names an element by ref, what it acts on: `{ element, title, url }`, e.g. `button "Submit for approval"` and its page — show this, the ref means nothing to a person), `risk?` (the filter's 0–1 probability), `reason?` (`filter-unavailable` when the filter could not judge, or when the browser could not say what the element is; `flagged` when the model's provider judged the call dangerous while the filter did not — then `explanation?` is the provider's words). May arrive before or after the call's `tool.call`. |
| `tool.approval.resolved` | `toolCallId`, `approved`, `reason?` (`unanswered`: a check-in's request that nobody answered before other follow-ups came due; counts as a no). Not sent when the run is cancelled while waiting. |
| `browser.handoff.requested` | The agent asks the user to take the browser over (`browser_handoff`) and waits: `toolCallId`, `handoffId`, `reason` (what to do on the page). The app offers Take over (`POST /v1/browser/handoff`) and Not now (`…/end` with `declined`). May arrive before the call's `tool.call`. A notification is sent, like for a held approval. |
| `browser.handoff.resolved` | `toolCallId`, `handoffId`, `outcome`: `done` (handed back), `declined`, or `unanswered` (as for approvals). Not sent when the run is cancelled while waiting. |
| `tool.result` | `toolCallId`, `name`, `output`, `isError` (a denied call ends as an error result saying the user declined) |
| `subagent.started` | A helper has begun a piece of work: `toolCallId` (the `delegate` call that sent it, or the `helper_message` call that sent it on), `agentId` (the id of the helper's conversation), `index` (its place among a `delegate` call's tasks; 0 for `helper_message`), `task` (the task, or the message). |
| `subagent.tool` | A helper called a tool: `agentId`, `name`, `input`. A helper's text, results and messages are not streamed; read its transcript. |
| `subagent.finished` | `agentId`, `status` (`completed` / `cancelled` / `failed`), `steps`, `error?`. All of a call's helpers finish before its `tool.result`. A helper that is sent on starts and finishes again. |
| `compaction.started`, `compaction.completed`, `compaction.failed` | Context size; messages summarised and memories saved; error |
| `run.completed` | `finishReason`, `steps`, `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` (`usage` includes what the run's helpers spent; `steps` counts the main agent's only) |
| `run.cancelled` / `run.failed` | — / `error` |

User messages with files include `attachments: [{ id, filename, mediaType, sizeBytes, createdAt }]`.
New uploads also include optional `drivePath`, the initial editable copy relative to Drive.
The upload completes after copying into `Uploads/<attachment-id>/<filename>`; filenames over 240
UTF-8 bytes are shortened for that copy. Upload retries preserve an existing copy and never recreate
one that was moved/deleted after a successful upload. A failed Drive copy returns an error while
retaining the immutable original; retry with the same request ID to finish it.
Clients upload first, then send the IDs in `attachmentIds`; the IDs remain valid after reconnects
and restarts. File bytes and model-only context are never included in message DTOs. Native image/PDF capability
can be disabled per model with `models[spec].media`. When earlier messages contain native media,
choose a compatible model or a new chat; Sunnie does not rewrite the stored prompt history.

`quotes` is an optional array of snapshots: `{ id, kind: "text" or "card", title, text }`.
Each ID is 1–200 characters and unique within the message; titles are 1–200 characters after
trimming. Limits are 8 quotes, 8,000 characters per quoted text and 32,000 total, measured in
UTF-16 code units. A card's `text` carries its Markdown/card representation; selected text
contains the exact excerpt. Quote-only sends use empty message `text`. The snapshots are
stored separately from typed text, included as reference material in the model context, and
returned unchanged in history and SSE. They are not source authentication or new instructions.
Clients should check `quoting.enabled` in `GET /v1/info` before offering quote attachment.

Message `parts` are `text`, `reasoning`, `tool_call` or `tool_result`. A client that only wants
chat bubbles can render `text` of `user` and `assistant` messages and ignore the rest.

A run belongs to the server: if the phone drops the connection the run keeps going. Reconnect
with `GET /v1/runs/:id/events?after=<last seq>`, or just re-fetch the messages.

A run also survives a server restart: it keeps its id, the conversation's `activeRunId` points
at it again, and it goes on from its last stored step. Its event stream starts anew with
`run.started`, numbered from a `seq` above anything sent before the restart (so `seq` rises but
is not contiguous), and `after=<last seq>` from before the restart returns all of it. A
shutdown ends open streams without a terminal event.

**Drive.** `/v1/info` advertises `drive: { enabled: true, maxFileBytes: 20971520, maxTextBytes: 262144 }`.
All Drive routes require the normal bearer token. Paths are relative to `~/Drive`, sent as query
values with normal URL encoding or as JSON strings. Absolute paths, empty components, `.` / `..`,
backslashes and control characters are rejected. Root listing/stat use the empty string. The file
system remains the source of truth; no content is duplicated into a separate Drive database.
Every operation runs through `Computer.exec` as the agent's user, using Python 3.11+ with directory
descriptors and no symlink traversal. Moves use native no-replace rename on Linux/macOS. A request
is limited to 30 seconds; after an interrupted mutation, refresh before retrying. Only attachment
copy metadata is recorded in the server database (migration 13). The app hides Drive on older servers.

**Cards.** An assistant message's `text` is Markdown. The agent may also write four fenced
blocks that a client can draw as cards (and may show as code if it does not know them). Inside,
one `key: value` per line: ` ```event ` (`title`, `start`, `end`, `place`, `note`; times are
local, `YYYY-MM-DD HH:MM`), ` ```schedule ` (`title`, then lines `time | what | detail`), and
` ```card ` (`title`, `subtitle`, `link`, and any other key as a labelled fact), plus
` ```drive ` (`title` and a literal Drive-relative `path`, both required). Drive references use
these cards instead of filesystem URLs; tapping opens a file's preview/edit screen or a folder.
Invalid Drive blocks fall back to code. Card quotes retain their title/path snapshot.

A fifth block, ` ```widget `, holds one JSON object instead of `key: value` lines: a body made of
the parts listed under [Home widgets](#home-widgets), for a card the
agent lays out itself. The server does not check it; a client draws what it knows, skips parts it
does not, and shows the block as code when nothing in it can be drawn. Its actions do no more than
on Home: `open_url` and `open_file` open, `ask` puts its prompt in the chat's message box for the
user to send, and `open_chat` does nothing in a reply. Drive paths are references that may not exist.

```widget
{"type":"row","valign":"center","children":[
  {"type":"stat","value":"8,412","label":"Steps today","caption":"goal 10,000"},
  {"type":"gauge","value":0.84,"label":"84%"}]}
```

```drive
title: Trip itinerary
path: Trips/Rome/itinerary.md
```

WhatsApp recommendations reuse `card`; `message` holds the readable draft and `link` holds
the shortcut. The app preserves the message's literal punctuation and labels HTTPS links to
the exact `wa.me` host **Open in WhatsApp**. The shortcut follows
[WhatsApp's click-to-chat format](https://faq.whatsapp.com/5913398998672934): a known full
international number as digits in the path, or no number so the user can choose a recipient.
The complete draft is percent-encoded in `text`; the user reviews and sends it in WhatsApp.

```card
title: Message Sam on WhatsApp
message: Hi Sam, are we still on for dinner at 7?
link: https://wa.me/?text=Hi%20Sam%2C%20are%20we%20still%20on%20for%20dinner%20at%207%3F
```

---

### Home widgets

A widget's `body` is one JSON object with a `type`. Writing a widget (`PUT`, `home_widget` "set")
writes its body whole, design and all; there is no template language. **Refreshing** it changes only
its data: every part that shows data has a `key` (one the writer gave, such as `"key":"steps"`, or its
type, `stat`, `stat-2`, … in order, which the server adds when the widget is written), and an update
(`PATCH /v1/home/widgets/:id`, `home_widget` "update") gives new data per key:
`{"values":{"steps":{"value":"9,120","caption":null}}}` (null clears a field). Data is `text`
(text, markdown), `value`, `label`, `unit`, `caption`, `icon` (stat), `items` (fields, list), `value`,
`label`, `caption` (progress, gauge), `values`, `labels`, `caption` (chart), `name` (icon), `text`,
`icon` (badge), `text`, `action` (button), `path` (image), `path`, `title`, `caption` (file), `to`,
`label` (countdown); anything else is design and an update refuses it. Keys are unique in a widget.
Limits: 32 kB, 160 nodes, 8 levels.

**Values and formulas.** Interactive parts each set a name (`bind`) in the widget's state; a name no
input sets can be given a starting value in `state` on the outermost part. Any text a part shows may hold
`{…}` formulas, worked out live as the user changes things: numbers, `'text'`, the names, `+ - * / %`,
`== != < <= > >=`, `&& || !`, `c ? a : b`, `min`, `max`, `round(x, digits)`, `floor`, `ceil`, `abs`,
`clamp(x, lo, hi)`, `if(c, a, b)`, `fixed(x, digits)`. Numbers show whole or with up to two decimals,
grouped with commas; a formula that does not read shows "—"; `{{` is a brace. A `progress` or `gauge`
`value` may be a formula (`"{done / 8}"`), and `when` on any part draws it only while its formula holds.
The server refuses a formula that does not read or names something the widget does not set. The same
language is in `src/home/formula.ts` and the app's `Formula.swift`; both run the cases in
`app/Sunnie/SunnieTests/FormulaCases.json`. No loops, no assignment, nothing outside the widget.

**Size.** Home is four columns across, and a widget spans `columns` of them: 1 (a small square tile),
2, 3 or 4 (the full width, the default). Each width has a budget the server enforces on every write
and update (`SIZE_BUDGETS`): Small holds one number, icon or ring with a word under it (3 parts, 30
characters, 10 a line, no heading, title or stat label, no lists, fields, charts or buttons); Medium a
focal value and a line or two (5 parts, 3 lines, 120 characters, 1 button); Large a heading, a value
and a little detail (8 parts, 5 lines, 260 characters, 2 buttons). Widgets fill Home left to right in order; one that does not fit
what is left of a line starts the next, and widgets side by side share their line's height. At the
largest text sizes the app widens 1 and 2 to half the width and 3 to the full width. The server rejects a type it does
not know; the app skips one it does not know, so the list can grow.

| Type | Fields |
| --- | --- |
| `text` | `text`, `style?` (`largeTitle`, `title`, `title2`, `title3`, `headline`, `subheadline`, `body`, `callout`, `footnote`, `caption`), `size?` (points, 8 to 96), `weight?` (`light` to `heavy`), `design?` (`default`, `rounded`, `monospaced`; `serif` is accepted and dropped), `lines?` |
| `markdown` | `text` (the same Markdown and cards as a reply) |
| `stat` | `value`, `label?`, `unit?`, `caption?`, `icon?` (an SF Symbol name) |
| `fields` | `items: [{ label, value }]` (up to 12) |
| `list` | `items: [{ title, subtitle?, value?, icon?, action? }]` (up to 20) |
| `progress` | `value` (0 to 1), `label?`, `caption?` |
| `gauge` | A ring: `value` (0 to 1), `label?` (in its middle), `caption?`, `size?` |
| `chart` | `values` (2 to 60 numbers), `kind?` (`line`, `bar`, `area`), `labels?`, `caption?`; `height` sets the plot's height |
| `icon` | `name` (an SF Symbol name), `size?` |
| `badge` | `text`, `icon?`: a tinted capsule; `background` fills it |
| `button` | `text`, `action` (required, as below), `icon?`, `variant?` (`filled`, the default; `tinted`; `plain`). At least 44 pt tall; `color` is its colour, else the one it inherits, else the app's tint; text on a filled one is white or black, whichever reads |
| `countdown` | `to` (ISO date-time with offset), `label?`, `style?`: counts down or up, live |
| `image` | `path` (a picture in Drive), `mode?` (`fill`, `fit`), `height`. The app loads no image from anywhere else. |
| `file` | `path` (a file or folder in Drive), `title?`, `caption?`: a row that opens it in the app |
| `divider`, `spacer` | none |
| `table` | `columns` (1 to 6), `rows` (up to 30 rows of cells), `caption?` |
| `stepper` | Sets `bind` (a state name): `value?` (where it starts), `min?`, `max?`, `step?`, `label?`, `unit?` |
| `slider` | Sets `bind`: `min`, `max`, `value?`, `step?`, `label?`, `unit?` |
| `toggle` | Sets `bind` to true/false: `label`, `value?` |
| `segmented` | Sets `bind` to one choice (tabs): `options` (2 to 6: words or `{ value, label }`), `value?` |
| `checklist` | Sets `bind` to one true/false per item: `items: [{ title, detail?, time? }]` (up to 30; with times it is drawn as a timeline), `caption?`, `value?`. In formulas its name is how many are ticked |
| `row` | `children` side by side (up to 6, equal widths; `fit: true` on a child keeps it to its own width), `valign?` (`top`, `center`, `bottom`, `baseline`) |
| `stack` | `children` one under the other (up to 16) |
| `grid` | `children` as tiles (up to 24), `columns?` (2 to 4); tiles in a row share its height |
| `layer` | `children` on top of each other, the first at the back (up to 6), `anchor?` (`topLeading` … `bottomTrailing`) |

**Style**, on any part: `color` (its text, icons and accents, inherited by its children), `background`,
`gradient` (2 or 3 colours) with `direction` (`down`, `right`, `diagonal`), `backgroundImage` (a Drive
picture behind the part, cropped to fill it; `background` or `gradient` is drawn over it, so a translucent
one is a scrim), `padding` (on the body: the card's inset), `corner`, `border`,
`opacity`, `align` (`leading`, `center`, `trailing`), `fit`, `height`. Containers also take `spacing` and an
`action`, so a tile can be tapped as a whole. A colour is a name (`primary`, `secondary`, `tertiary`,
`accent`, `petal`, `white`, `black`, `gray`, `red`, `orange`, `yellow`, `green`, `mint`, `teal`, `cyan`,
`blue`, `indigo`, `purple`, `pink`, `brown`) or hex (`#RGB`, `#RRGGBB`, `#RRGGBBAA`). A background,
gradient or picture on the body itself fills the whole card.

**Actions** (`action` on a button, a list item or a container; `link` / `file` / `ask` on the widget):
`{ type: "open_url", url }` (https only), `{ type: "open_file", path }`, `{ type: "ask", prompt }` (a new chat
with the prompt in the composer; the user sends it), `{ type: "open_chat", conversationId }`,
`{ type: "copy", text }`, `{ type: "calendar", title, start, end?, place?, note? }` (times `YYYY-MM-DD HH:MM`,
local; the app offers it as an event card), and — in a card in a chat reply only, never on Home —
`{ type: "reply", text }`, which sends the words as the user's message in that chat, like a quick reply.
Words in an action may hold formulas. A Home widget never sends a message or runs anything itself.

**Drive.** Paths are relative to `~/Drive`, as in a `drive` card. A widget points at Drive through a
`file` or `image` part, a `backgroundImage` or an `{ type: "open_file", path }` action. An absolute path
through the agent's `Drive/` folder (as an attachment's `drivePath` reaches the model) is made relative. `home_widget` looks every path up
before writing (a missing file is an error the model can fix); `PUT /v1/home/widgets/:id` checks only
the path's shape. Like a `drive` card, a widget references the file at that path: moving or deleting
it leaves a row that says it could not be opened.

Text fields also accept numbers. The app opens only https links.

```sh
curl -X PUT "$SUNNIE_URL/v1/home/widgets/steps" -H "Authorization: Bearer $SUNNIE_API_KEY" \
  -H 'content-type: application/json' -d '{"title":"Steps","hours":24,
  "body":{"type":"row","children":[{"type":"stat","value":"8,412","caption":"goal 10,000"},{"type":"progress","value":0.84}]}}'
```

## How it works

**A turn** (`src/agent/agent.ts`). The user's message is stored with a small context block
(current time in their zone, auto-recalled memories). Then, per step: compact if the context is
over budget → ask the router what comes next → call the model with that decision → show each tool
call to the risk filter, and wait for the user if it is high risk → run it on the computer → store the step atomically. The loop ends when the model replies without
a tool call (or at `agent.maxSteps`).

**Two different routers.** They are easy to confuse:

- *Which tool next?* — Sunnie's own tool router (`src/router/`), asking Jev one Choice question
  whose options are the tools plus "reply to the user". A confident answer is enforced through
  `toolChoice`; an unsure one, or any error, leaves the choice to the language model. Jev picks
  *which* tool; the language model still writes the arguments and the reply.
- *What if the model cannot be forced?* — Some providers accept no tool choice but `auto` (Meta, Z.AI). The
  router's decision then travels as a short note behind the last message of that one call ("the
  next step has been chosen for you: call the `shell` tool now"), never stored, so the cached
  prefix is untouched. "Reply now" stays enforced either way: a tool call made in such a step is
  refused before it runs.
- *Which model answers?* — never Jev. The language model is one pinned spec (`agent.defaultModel`,
  or a conversation's or a message's own). Jev decides what to do next; the pinned model does the
  work. OpenRouter also offers a model router under the Jev name (`typesafe/jev-router`); Sunnie
  does not use it.

**Approvals.** The risk filter (`src/router/risk.ts`) is a second, separate use of Jev: one
yes/no question per tool call — "is this high risk, so the user should confirm it first?" — over
the recent conversation and the call's name and input. A browser call names its element only by
a ref, so the gate first asks the browser what that ref stands for (the element's role and name,
and its page) and gives that to the filter and to the approval the user sees; a click whose
element the browser could not name is held. The gate wraps each tool's `execute`, so
the tool list the model sees is unchanged and the wait happens inside the step: the step is
still stored whole, with the call and its result (or the "declined" error). The run manager
holds the pending question; the answer arrives through the approvals route.

**Prompt caching.** Providers cache by exact prefix, so everything early in the request must
not change between calls: the system prompt is rendered from a snapshot of core memory taken
when the conversation (re)starts; the tool list is identical on every call (routing steers with
`toolChoice` instead of trimming it); stored messages are never rewritten; and the clock and
recalled memories are attached to the user message they arrived with. On OpenRouter each
request also carries the conversation id as `session_id` / `prompt_cache_key`, which pins the
conversation to one upstream provider and, for router models, one resolved model.

**Memory.** Core memory sits in the system prompt and is edited by the agent itself. For each
incoming message the recall filter (`src/router/recall.ts`, a third use of Jev) answers one
yes/no question: does this message call for a recall? On a yes the agent loop attaches the
memories nearest in meaning (`src/memory/semantic.ts`: the message and the three before it are
embedded in one call, together with any memory written or changed since the last one; vectors
live in `memory_vectors`, keyed by model and content hash, and every one is compared on each
search), and the matching messages of earlier conversations. The embedding and the Jev decision
are awaited together. Without an embedding model, or when it does not answer in time, it attaches
keyword matches from archival memory (`src/memory/recall.ts`: the words of the message, and at
half weight those of the three messages before it, so that "book it" finds what the turn before
was about; between equal matches the memory touched later leads), topped up with the most
recently touched memories, and the matching messages of earlier conversations; on a no, nothing rides along. Saving is decided in the routing request: next to "which tool
next?" Jev is asked whether the user's latest message told the agent something durable that
memory does not hold yet, and a confident yes makes `memory_save` the next step — asked only
until the agent has written to memory in that turn. The agent can also search and save
deliberately, and compaction still extracts memories (it is shown what the conversation already
saved, so it does not save the same fact reworded). A new memory's tool result lists stored ones
that share most of its words, so a changed fact can replace the old one. The raw history is never deleted and stays
searchable through `conversation_search`.

**Compaction.** Budget = `min(contextWindow × threshold, maxContextTokens)`. Over budget, the
cut is placed at a turn boundary (never between a tool call and its result), everything before
it is summarised into the rolling summary, and durable facts are written to archival memory.
Since that rewrites the prefix anyway, the core-memory snapshot is refreshed at the same time.

**Heartbeat.** A timer in the server (`src/agent/heartbeat.ts`), started by the process entry.
Each tick reads the `tasks` table for open follow-ups whose `due_at` has passed. When none are
due it considers active, unmuted interests unless discovery is paused; with neither, it does nothing. A due follow-up
starts an ordinary run through the run manager in the one
conversation of kind `heartbeat`, opened by a message that carries the due follow-ups and the
check-in instructions for the model (`content`) and a short list for the human (`text`), marked
`origin: "heartbeat"`. The follow-ups are pushed out by `recheckMinutes` as the run starts, so
later ticks leave them alone. When the run completes, each follow-up the agent did not move or
edit is closed; if the run failed or was cancelled they stay open and come back. Everything else
— tools, router, risk filter, approvals, compaction — is the normal turn loop. The tool router
and the risk filter read a check-in's instructions (not just the human-visible line), because
that is where the request is. A tick is skipped while the Check-ins conversation is busy.

**Interest discovery.** `memory_save` accepts optional `interest_topic`, `interest_action`
(`none`, `remember`, `mute`, `resume`) and `proactive_updates` (`unchanged`, `pause`, `resume`).
The model writes these alongside the remembered preference, so saving and scheduling do not
depend on a later tool call. `none` and `unchanged` are the defaults spelled out, for models that
fill in every argument: an ordinary remember follows nothing and leaves the pause alone. Topic status and the global pause live in server-owned SQLite tables (migration 12).
Ordinary remembering preserves a mute; only explicit resume changes it. Deleting the linked
memory also mutes its topic. The latest preference snapshot goes on each new user message or
steer, never into the changing system prompt.

The heartbeat alone controls when an interest check-in can start. It uses the existing
configured interval and skips a busy Check-ins conversation; a new topic does not wait a day.
The check-in decides whether to research or share now, considering earlier opportunities and
findings, and can stay quiet without researching. Topics rotate by last check time, recorded
in the transaction creating the run; bounded prior reports and source URLs help avoid repeats.
The former daily-deadline column is left intact for migration compatibility but is no longer
read or written. Automatic discovery uses the existing turn loop with an eight-step limit
and a read-only tool gate; permitted calls still pass the ordinary risk filter. No helpers,
new follow-ups or external actions can run in that mode. Tool-step narration and the exact
`NOTHING_TO_SHARE` sentinel stay in model history with empty human text. A real user steer
returns the run to normal chat behavior. Disabling heartbeat, muting a topic or pausing updates
prevents an unfinished automatic digest from resuming after a restart.

**Helpers.** `delegate` takes a list of tasks. For each one `runHelpers` (`src/agent/subagents.ts`)
creates a conversation of kind `subagent` whose parent is the conversation of the turn, and runs
the ordinary turn loop in it with the task as the opening message — so a helper has the router,
the risk filter, retries, compaction and a stored transcript without any of that being written
twice. What differs is decided by the conversation's kind inside `runTurn`: the system prompt
(`buildHelperInstructions`), the tool set (`createHelperTools`: computer, `web_fetch`, `web_search`, browser
without the vault), no recall, `subagents.maxSteps`, and no `confirm` — a held call is declined.
At most `subagents.concurrency` run at once; the rest of the list waits. The helpers share the
parent run's abort signal, their token usage is added to the run's, and of their events only the
tool calls are passed on (`subagent.tool`). Their last messages, capped, are joined into the
`delegate` call's result, each headed by its helper's id; if none came back with anything the
call fails and the agent is told to do the work itself. Communication is one way by default:
task down, report up. `allow_questions` on a `delegate` call adds a line to those tasks (stored
with the message, not in the shared system prompt) permitting a question in the report, and
`helper_message` is the way back: the next message in that helper's conversation, run as
another turn of the same loop. A cancelled turn waits for its helpers to stop before it ends.

**Browser.** The browser is part of the agent's computer, not of the server. `browser/daemon.ts` runs there as the agent's user, owns one Google Chrome with a persistent profile (`~/.sunnie/browser/profile-chrome`; the Chromium fallback keeps its own in `profile`), and exits after 30 idle minutes; session cookies are saved and restored so that does not sign the agent out. The daemon clears a stale profile lock before starting Chrome, starts a new browser when the old one died, and closes one that holds a command for more than 75 seconds. Chrome runs headed; on Linux without a display the daemon starts Xvfb for it and falls back to headless only if Xvfb is missing. Commands carry a session: the agent's own (the default) or a helper's. Each session has its own current page and sees only its own tabs; commands of one session run in order, sessions run side by side, and a helper's tabs are closed when it finishes (`end`). Each browser tool call runs `browser/client.ts` through `Computer.exec`, which passes one JSON command to the daemon over a Unix socket and prints the answer. Pages are returned as Playwright's accessibility outline with `[ref=…]` markers; the model acts on refs. `browser_upload` puts files of the agent's computer into a file field, or into the picker a button opens (the daemon reads them there; the server never does); a file picker nobody asked for is answered with nothing and a note. `describe` tells the gate what a ref stands for without touching the page. A vault value travels on the command's stdin, is refused unless the page's host matches the login's site, and is stripped from anything read back (by the daemon, and again by the server).

**Agent Skills.** The [Agent Skills format](https://agentskills.io/specification) is supported
through `skills/client.ts`, which runs only on the agent's computer. Immediate child directories
of `~/.agents/skills/` and `~/.sunnie/skills/` are scanned; `.agents` wins on duplicate names.
Arbitrary cloned projects are not scanned. The skills shipped with Sunnie (`skills/bundled/`,
beside the client, with the server's code) are scanned last, so a skill of the agent's own with the
same name replaces one quietly. A shipped skill is off until the user turns it on (`skill_switches`
table, `PATCH /v1/skills/:name`): until then it is left out of the catalog the agent is given and
`skill_read` refuses it. The switch decides what is offered, not what can be read: the files stay
readable with the ordinary file tools. Each skill has a `SKILL.md` with YAML `name` and
`description`, followed by Markdown; optional metadata and supporting files are preserved.
Invalid files are reported without preventing the rest of the catalog from loading.

The catalog is snapshotted on each new message, including steers and helper tasks. Jev sees that
same stored catalog when routing. The system prompt and tool schemas stay stable; full
instructions enter history only through `skill_read`, and scripts/references are read as needed.
`skill_list` refreshes discovery during a turn or after compaction. `skill_write` validates and
atomically replaces only a skill's instructions, preserving its supporting files. The ordinary
file tools can add scripts and references. Helpers get only `skill_list` and `skill_read`.

`skill_install` takes a repository URL, skill directory, and optional branch/tag/commit. Every
new source is held for approval even when Jev approvals are disabled. Only an affirmative user
answer records trust in the server-owned `skill_sources` table (migration 10); no model-written
file can grant that trust. Installs fetch a shallow Git snapshot, copy the selected directory,
and record its resolved commit in `.sunnie-source.json`. No checkout hooks, filters, submodules
or bundled scripts run. Existing skills are not overwritten. Bounds: 100 discovered skills,
64 KiB per `SKILL.md`, 256 files / 20 MiB per installed bundle, and a two-minute command limit.
Symlinks and submodules are rejected. The initial installer supports HTTPS repositories that
can be fetched without an interactive login; it does not provision repository credentials.

Ask in chat to "save this procedure as a skill" or "install the skill at `<directory>` from
`<repository URL>`". A skill can explain a GitHub workflow using Git, a CLI or the browser
without adding a GitHub-specific server tool. Skills do not supply authentication or missing
software. `allowed-tools` metadata never grants permissions; all called tools still pass the
risk filter. Source approval governs `skill_install`; the existing shell and file tools remain
general-purpose, and installed skills are editable instructions, not a separate security sandbox.

**Security model.** The server holds the secrets; the agent holds a computer. Commands get a
minimal environment, and in Docker run as a different, unprivileged user. Tools reach the
outside world only through that computer. The API is bearer-token only — terminate TLS in a
reverse proxy (Caddy, Tailscale Serve, Cloudflare Tunnel) before exposing it.

---

## Licence

Sunnie is source available under the [Functional Source License 1.1, ALv2 Future License](LICENSE.md):
read it, change it and run it for yourself or your organisation for free; offering it to others as a
competing commercial product or service is not allowed. Each version becomes Apache-2.0 two years
after its release. The demo music and the Sunnie name and logo are not covered: see [NOTICE.md](NOTICE.md).

## Local state (not in git)

- `app/Sunnie/Signing.local.xcconfig` — the Apple team and bundle ID prefix of the App Store build.
- `.env` — `SUNNIE_API_KEY` (generated), `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `EXA_API_KEY`.
- `data/config.json` — sets this checkout's default model to `openrouter/openai/gpt-6.1-sol`
  with medium reasoning, for the initial testing phase. Delete it to fall back to the built-in
  default (the same model, without the reasoning setting).
