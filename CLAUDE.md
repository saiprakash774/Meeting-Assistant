# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Start Vite dev server (http://localhost:5173)
npm run build        # tsc -b && vite build → outputs to dist/
npm run lint         # Run ESLint
npm run preview      # Serve production build locally
```

There is no test runner configured.

## Architecture

**TwinMind Live Suggestions** is a single-page React/TypeScript app that records microphone audio, transcribes it via Groq Whisper, and generates contextual meeting suggestions using Groq's chat API. No backend — all API calls go directly from the browser.

### Source structure

```
src/
  types.ts              — all shared TypeScript types (TranscriptEntry, Suggestion, AppSettings, …)
  constants.ts          — all constants, DEFAULT_SETTINGS, intentLabelMap, TRANSCRIPT_NOISE_PATTERNS
  lib/
    groq.ts             — async functions wrapping Groq REST API: transcribeAudioChunk, createLiveSuggestions,
                          createDetailedSuggestionAnswer, createAssistantChatReply, buildExportPayload
    utils.ts            — nowIso, makeId, sanitizeAssistantMarkdown, getVibeFromText, buildSessionHeader,
                          isDailyLimitError, extractWaitTime, ATTRIBUTION_RE, FOLLOWUP_OFFER_RE
  hooks/
    useTranscript.ts    — transcript[], livePreview[], hasFirstRealCommit, transcriptTextRef, pendingTranscriptPartsRef
    useAudioRecorder.ts — MediaRecorder lifecycle, 5s cycles, transcript commit timer, flushAndCommitAllPending
    useSuggestions.ts   — suggestion batches, auto-refresh timer, silence watch, daily-limit handling
    useChat.ts          — chatMessages[], handleSuggestionClick, handleChatSubmit
  components/
    TranscriptPanel.tsx   — left column (purely presentational)
    SuggestionsPanel.tsx  — middle column (purely presentational)
    ChatPanel.tsx         — right column, uses ReactMarkdown (purely presentational)
    SettingsScreen.tsx    — settings overlay (purely presentational)
  App.tsx               — thin orchestration: wires hooks together, handleStart/handleStop, export, cleanup (~184 lines)
```

### Data flow

```
MediaRecorder (5s cycles → 30s commits)
  → transcribeAudioChunk()       [Groq Whisper: whisper-large-v3]
  → addTranscriptEntry()         [filtered, added to livePreview + pendingTranscriptPartsRef]
  → commitPendingTranscript()    [every 30s — advances hasFirstRealCommit + lastRealCommitAtRef]

Timer (starts after first real 30s commit)
  → createLiveSuggestions()      [Groq Chat: openai/gpt-oss-120b]
  → suggestionBatches[] state    (newest-first, each batch has up to 3 suggestions)

User clicks suggestion
  → createDetailedSuggestionAnswer()
  → chat panel with full markdown answer

User types in chat
  → createAssistantChatReply()   [last 12 messages + transcript context]
  → chatMessages[] state
```

### State & persistence

All session state (transcript, suggestions, chat) is in-memory — lost on page reload. `AppSettings` (API key, intervals, context window sizes, system prompts) persists to `localStorage` under key `twinmind_assignment_settings`.

### API models & key parameters

| Function | Model | Max tokens | Temp |
|---|---|---|---|
| `transcribeAudioChunk` | `whisper-large-v3` | — | — |
| `createLiveSuggestions` | `openai/gpt-oss-120b` | 550 | 0.3 |
| `createDetailedSuggestionAnswer` | `openai/gpt-oss-120b` | 2 000 | 0.35 |
| `createAssistantChatReply` | `openai/gpt-oss-120b` | 2 000 | 0.35 |

Context windows are sliced from `transcriptTextRef.current` (a plain-text buffer, not React state) to avoid re-renders. Default sizes: suggestions=4 500 chars, chat=8 500 chars. Session date header is prepended to all context strings via `buildSessionHeader()`.

### Key gates & thresholds

| Constant | Value | Purpose |
|---|---|---|
| `MIN_REAL_COMMIT_WORDS` | 5 | A 30s commit must have ≥5 words to count as real speech |
| `MIN_SUGGESTION_CONTEXT_CHARS` | 300 | Context must be ≥300 chars before any suggestion API call |
| `MIN_NEW_CHARS_FOR_REFRESH` | 150 | Manual reload requires ≥150 new chars since last generation |
| `SILENCE_THRESHOLD_MS` | 60 000 | No real commit for 60s → pause suggestion timer |
| `REFRESH_COOLDOWN_MS` | 10 000 | Minimum gap between manual reloads |

### Guardrails (two layers)

1. **API layer** (`groq.ts` `SYSTEM_RULES`): 8 hard rules injected into every detail/chat system prompt — immune to stale localStorage prompts. Covers intent, focus, context anchoring, accuracy, uncertainty labelling, relevance, date handling, and no-attribution.
2. **Prompt layer** (`DEFAULT_SETTINGS`): BEFORE/WHEN/QUALITY CHECK structure in all three prompts. Includes topic discipline, no-invented-facts, and structured output rules.

### Suggestion parsing

`parseSuggestions` in [src/lib/groq.ts](src/lib/groq.ts) returns 0–3 valid suggestions — no padding with fallbacks. A batch is only committed to state if it contains ≥2 suggestions.

### Silence detection

`startSilenceWatch` polls every 1s. Uses `lastRealCommitAtRef` (updated only when `commitPendingTranscript` produces a real entry meeting `MIN_REAL_COMMIT_WORDS`). After `SILENCE_THRESHOLD_MS` without a real commit, the suggestion timer pauses. It auto-resumes when speech returns.

### UI layout

3-column CSS Grid (collapses to single column below 1 100px):
- Left: timestamped transcript timeline + mic toggle
- Center: suggestion batches, newest on top, with reload button and countdown
- Right: chat interface with session-only badge

### TypeScript types

All shared types live in [src/types.ts](src/types.ts): `TranscriptEntry`, `Suggestion`, `SuggestionBatch`, `ChatMessage`, `AppSettings`, `Vibe`, `ChatRole`, `RefreshTrigger`.
