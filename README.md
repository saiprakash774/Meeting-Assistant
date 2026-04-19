# TwinMind Live Suggestions — Meeting Copilot

A browser-based meeting assistant that listens to your microphone, transcribes what is being said in real time, and generates smart suggestions to help you contribute better to the conversation. You can click any suggestion to get a detailed breakdown, or type your own question into the chat at any time.

Everything runs directly in the browser. There is no backend server — all AI calls go straight from the browser to Groq's API.

---

## What it does

- Records your microphone in 5-second cycles and sends each clip to Groq Whisper for transcription
- Shows a live preview of what was just said every ~5 seconds (shown in italic, unconfirmed)
- Commits the transcribed text into the confirmed transcript every 30 seconds
- Automatically generates 3 contextual suggestions every 30 seconds once real speech is detected
- Clicking a suggestion expands it into a detailed answer in the Chat panel
- You can type any free-form question into chat and get an answer grounded in what was said
- A vibe indicator at the top shows the overall tone of the meeting — positive, neutral, or critical

---

## Tech stack

| Layer | Choice |
|---|---|
| UI | React 18 with TypeScript |
| Build tool | Vite |
| Transcription | Groq Whisper (whisper-large-v3) |
| Suggestions and Chat | Groq Chat (openai/gpt-oss-120b) |
| Markdown rendering | react-markdown |
| Styling | Plain CSS, no UI framework |
| Persistence | localStorage for settings only; all session data is in-memory |

---

## Local setup

```bash
npm install
npm run dev        # starts at http://localhost:5173
npm run build      # production build → dist/
npm run lint       # ESLint
npm run preview    # serve the production build locally
```

You need a free Groq API key from console.groq.com. Add it in the Settings panel — it is saved to localStorage and is only ever sent directly to Groq.

---

## How to use it

1. Click **Settings** in the top right and paste your Groq API key
2. Optionally add a Meeting Context — a short description of who is in the meeting and what it is about. This gets included in every AI call to make responses more relevant
3. Click **Back** to return to the main view
4. Click **▶ Start Mic** in the Transcript panel
5. Start speaking — a live preview appears within a few seconds, and confirmed transcript entries appear every ~30 seconds
6. After the first 30-second chunk of real speech is committed, suggestions start generating automatically
7. Click any suggestion card to get a detailed answer in the Chat panel
8. Type any question in the chat input at any time
9. Click **Export Session** to download everything as a JSON file

---

## Layout

The app has three panels side by side.

**Left — Mic and Transcript**
Shows confirmed transcript entries with timestamps. A live unconfirmed preview appears below them. Start and stop the mic from here.

**Middle — Live Suggestions**
Shows suggestion batches, newest on top. Each card has an intent label (question to ask, answer, fact check, talking point, or clarify), a short preview, and a title. Click any card to expand it in Chat.

**Right — Chat**
A running conversation with the AI. Gets populated either by clicking suggestion cards or by typing your own questions. Always available, even when the mic is off.

---

## Why 5-second preview and 30-second confirmed transcript

The 30-second commit is the main structure — the confirmed transcript and all AI context use 30-second committed chunks.

The 5-second live preview was added on top because waiting 30 seconds to see any feedback during a live conversation feels too slow. The preview just shows what was recently said so you can follow along. It does not replace or affect the 30-second structure.

In short: the 5-second preview is for usability; the 30-second chunks are for stable AI context.

---

## How the suggestion system works

**When suggestions start**

Suggestions do not start the moment you click Start Mic. They wait until the first real 30-second transcript commit contains at least 5 meaningful words. This prevents the system from sending empty or thin context to the model, which causes errors.

The states are:

- Mic off — countdown is frozen, Reload button is disabled
- Mic on, no real speech yet — countdown is frozen, Reload is disabled
- First real 30-second commit received — first suggestion batch generates immediately, then auto-refresh fires every 30 seconds
- Silence mid-session — if no real speech is committed for 60 seconds, the suggestion timer pauses automatically to avoid redundant API calls. It resumes when speech returns
- On Stop Mic — one final suggestion batch is generated from everything recorded, then all suggestion activity stops

**Manual Reload**

The Reload button has a 10-second cooldown between clicks to prevent wasting API tokens. It is also disabled when the mic is off. If you click Reload and the transcript has not grown meaningfully since the last generation, you will see an informational message explaining why rather than a silent no-op.

**Anti-repetition**

Before each suggestion request, the titles from the previous 3 batches are sent to the model as a "do not repeat these" instruction. This ensures each batch brings fresh angles on the conversation.

**Minimum quality bar**

A batch is only saved if the model returns at least 2 valid suggestions. If it returns fewer — which can happen when the context is very short or repetitive — the batch is silently skipped rather than showing something incomplete.

---

## How the transcript works

Audio is recorded in a 5-second stop-and-restart cycle. Each cycle produces a complete, standalone WebM file. This is important because Groq Whisper only accepts valid audio files — the browser's timeslice mode produces headerless chunks that Whisper rejects.

A 10 KB minimum size check is applied to every audio blob. Anything smaller is just a WebM header stub with no real audio content, so it is discarded before reaching the API.

Short noise phrases like "thank you", "bye", and "you" are filtered out before being added to the transcript.

**Noise gate (optional)**

If background noise is causing false transcriptions, you can turn on the noise gate in Settings and set a minimum chunk size (default 25 KB). Five seconds of silence in WebM/Opus format encodes to around 15–20 KB, while real speech usually comes in above 30 KB. This is a rough but practical filter.

---

## Chat panel

Chat is always available, even when the mic is off.

When you click a suggestion card, the preview text is sent as a user message and the model expands it into a detailed structured answer using the full transcript as context.

When you type a question yourself, the most recent 8500 characters of transcript are included as context. The last 12 messages of chat history are also sent on each request to keep the conversation coherent without hitting token limits.


---

## Prompt strategy

All three AI functions — suggestions, detail expansion, and chat — use the same Groq chat model. The prompts are editable in Settings and saved to localStorage. A Reset prompts button in Settings restores the original defaults.

**Live suggestions prompt**

Tells the model to return exactly 3 suggestions as a JSON object with a title, a 1–2 sentence preview, and an intent label. The intent can be one of: question, answer, fact_check, talking_point, or clarify. The prompt asks for varied types — not three of the same — and stresses that each suggestion should be immediately useful in a live conversation, not generic advice.

**Detail answer prompt**

Takes a single suggestion and expands it into a structured markdown response: Summary (one sentence), Key Details (bullet points), and Action Items (numbered steps). Markdown tables and long horizontal rules are banned because they render poorly in the narrow chat panel.

**Chat prompt**

Answers any free-form question using the transcript as the primary source. Same formatting rules as the detail prompt. Labels inferences clearly and does not fill in gaps with assumptions.

**Rules always enforced in code**

Nine guardrails are always injected into every detail and chat system prompt in code, regardless of what is stored in localStorage. This means they cannot be accidentally removed by resetting or editing prompts. They cover: answering the actual intent, staying on topic, using the transcript as the source of truth, not inventing facts, labelling uncertainty, keeping every sentence relevant, using the session date header for dates, never appending attribution signatures, and never offering unsolicited follow-up actions.

---

## Error handling and reliability

**Retry logic**

| Scenario | Retries | Backoff |
|---|---|---|
| Whisper 503 (over capacity) | Up to 4 attempts | 1s, 2s, 4s |
| Chat 429 per-minute rate limit | Up to 4 attempts | 2s, 4s, 8s |
| Chat 429 daily token limit | No retry | Error surfaced immediately — retrying a daily limit only burns remaining quota |

**Daily token limit handling**

When the daily quota is reached, the app does not show a red error. Instead it shows a calm informational message with the exact wait time Groq provides (e.g. "Try again in 11m38"). The suggestion timer is stopped automatically so no further doomed requests are sent. If the limit is hit in chat, the message appears as an assistant reply in the chat thread rather than interrupting the whole interface.

---

## Settings reference

| Setting | Default | Description |
|---|---|---|
| Groq API Key | — | Your key, stored in localStorage, sent only to Groq |
| Meeting Context | — | Background text injected into every AI prompt |
| Suggestion interval | 30 000 ms | How often auto-refresh fires (minimum 10 000 ms) |
| Suggestion context chars | 4 500 | How much recent transcript is sent for suggestions |
| Detail answer context chars | 8 000 | How much transcript is sent when expanding a suggestion into a full answer |
| Chat context chars | 8 500 | How much recent transcript is sent for chat |
| Noise gate | Off | When on, skips audio chunks below the size threshold |
| Min chunk size | 25 KB | The noise gate threshold |

---

## Tradeoffs

**Client-side API calls** — The Groq key is stored in the browser and calls go directly from the browser to Groq. This keeps setup simple but means the key is visible in browser storage. For a real product this would go through a backend.

**No session persistence** — Transcript, suggestions, and chat are in-memory and are lost on page reload. This is intentional — live meeting data should not silently persist across sessions.

**No request cancellation** — If a suggestion or chat request is in flight when you stop the mic, it will complete and the result will appear. Adding AbortController support would fix this cleanly but was not prioritized.

**Vibe detection is keyword-based** — It counts keyword matches against a curated set of meeting-specific terms across positive, neutral, and critical categories. This is intentionally lightweight — it updates in real time without any extra API calls or latency. A full semantic sentiment model would be more precise but would add cost and delay on every transcript update.

**Noise gate is size-based** — Blob size is used as a rough proxy for whether speech was present. Real voice activity detection would be more accurate but adds significant complexity.

---

## Enhancements made during development

These are things that were not in the original plan but were added because they made the app meaningfully better or fixed real problems that came up during testing.

---

**Commit-based suggestion gates**

Originally the suggestion system started counting from the first audio blob received, which meant even a single word like "okay" would kick off the suggestion timer and start calling the API with almost no context. The model would return irrelevant or hallucinated suggestions because there was nothing meaningful to work with.

The fix was to only open the suggestion gate after the first 30-second commit that contains at least 5 real words. This means suggestions only start when there is actually something worth analysing. It also means silence and short noise fragments do not accidentally trigger anything.

---

**Silence detection that actually works**

The first version of silence detection watched for audio blobs stopping, but silent audio in WebM/Opus format still produces blobs of around 15–20 KB — enough to pass the size check. So the timer kept running even during extended silences, wasting API calls on stale context.

The fix was to track silence at the commit level instead. If no 30-second commit with real words arrives for 60 seconds, the suggestion timer pauses automatically. When speech resumes and a real commit happens, the timer starts again on its own. No manual action needed.

---

**Noise filtering for Whisper hallucinations**

Groq Whisper sometimes transcribes silence as "Silence." or just "." — it hallucinates text when there is no real speech in the audio. These fragments were making it into the transcript and being counted as real content.

Two filters were added: anything with fewer than two actual letters is discarded immediately, and a list of known noise phrases like "silence", "thank you", and "bye" are filtered when they appear on their own. This keeps the transcript clean and prevents the suggestion system from treating noise as real context.

---

**Session date injected into every AI call**

When asked to produce meeting minutes, the model was writing things like "Meeting held in the evening" or guessing years based on its training data. It had no way to know the actual date.

The fix was to record the exact date, start time, and timezone when you click Start Mic, and prepend that as a metadata block to every AI context string. The model is told to use this block as the authoritative date and never infer or guess it.

---

**Nine-rule guardrail system**

The model was occasionally drifting — adding attribution signatures like "Prepared by: Internal meeting recorder", inventing context not in the transcript, or answering a broader question than the one asked.

Nine guardrails are now injected at the code level into every detail and chat prompt. They cannot be overridden by editing the prompts in Settings. The rules cover: answering the actual intent, staying on topic, using the transcript as the source of truth, not speculating, labelling uncertainty clearly, keeping every sentence relevant, using the injected date, never adding attribution signatures, and never appending unsolicited offers to reformat or continue the output.

The attribution filter also runs on the output after the model responds — any line that starts with "Prepared by", "Generated by", or similar (including markdown-formatted variants like "- **Prepared by:**") is stripped before it reaches the chat panel.

---

## Vibe indicator

The vibe pill at the top updates whenever a new transcript chunk is committed (roughly every 30 seconds), based on the most recent 2000 characters of the confirmed transcript.

- **Critical (red)** — words like blocked, bug, crash, outage, failure, risk, escalate, behind schedule, and similar
- **Positive (green)** — words like shipped, launched, great job, well done, congratulations, kudos, on track, approved, and similar
- **Neutral (yellow)** — default when neither side is clearly dominant

Critical wins if there is at least one critical keyword and the critical count is equal to or higher than the positive count. This prevents discussions about fixing production issues from showing as neutral.

---

**Informational messages instead of red errors for normal situations**

When the user clicked Reload and nothing had changed, the app was either silently doing nothing or showing a confusing red error. When the suggestion timer was paused due to silence, the message still said "auto-refresh will trigger when more context arrives" — implying the timer was running when it was not.

A separate informational message state was added (shown in blue, not red). Red errors are now reserved for real failures like network errors or API key problems. Normal situations like "not enough new content yet" or "timer is paused due to silence" show calm blue messages that explain what is happening and what to expect.

---

**Daily token limit handled as a quiet pause, not a crash**

When the Groq daily token quota was reached, the app showed a red error banner and the suggestion timer kept firing every 30 seconds — all of which would fail immediately, burning any remaining quota.

Now the app detects when the error is a daily limit rather than a real failure. For suggestions, it stops the timer, shows a blue message with the exact wait time Groq provides, and waits. For chat, the quota message appears as an assistant reply in the conversation thread so it feels natural rather than alarming. Nothing retries automatically — there is no point until the quota resets.

---

**Expanded vibe keywords for real meeting language**

The original vibe keywords were generic and missed common meeting phrases. Words like "congratulations", "well done", "good work", "kudos", "nailed it", "on track", and "agreed" were not counted as positive. Meeting process words like "action item", "follow-up", "retrospective", and "sprint" were not in the neutral set. Risk words like "blocker", "escalate", "behind schedule", "at risk", and "showstopper" were not in the critical set.

All three categories were expanded with meeting-specific language so the vibe indicator reflects what is actually being said rather than just a narrow set of generic words.

---

**Stop-trigger suggestion fix**

When you clicked Stop Mic, the app was supposed to generate one final suggestion batch from everything recorded. This was silently not working — a bug where the ref that tracked whether real speech had been recorded was reset to false before the check that used it, so the condition was always false.

The fix captures the value before resetting it, so the final batch now generates correctly when you stop recording.

---

## Submission checklist

- [x] README with setup, stack, prompt strategy, and tradeoffs
- [ ] Deployed public URL
- [ ] Public GitHub repository link
