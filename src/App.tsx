import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import './App.css'
import {
  buildExportPayload,
  createAssistantChatReply,
  createDetailedSuggestionAnswer,
  createLiveSuggestions,
  transcribeAudioChunk,
} from './lib/groq'

type TranscriptEntry = {
  id: string
  text: string
  createdAt: string
}

type Suggestion = {
  id: string
  title: string
  preview: string
  intent: string
}

type SuggestionBatch = {
  id: string
  createdAt: string
  latencyMs: number
  suggestions: Suggestion[]
}

type ChatRole = 'user' | 'assistant'

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  createdAt: string
  latencyMs?: number
  contextTag?: string
}

type Vibe = 'positive' | 'neutral' | 'critical'

type AppSettings = {
  apiKey: string
  meetingContext: string
  suggestionIntervalMs: number
  suggestionContextChars: number
  chatContextChars: number
  noiseGateEnabled: boolean
  noiseGateMinKb: number
  liveSuggestionsPrompt: string
  detailAnswerPrompt: string
  chatPrompt: string
}

// 'manual'  — user clicked Reload; cooldown applies, sets lastRefreshAt
// 'auto'    — timer fired;         no cooldown, does not touch lastRefreshAt
// 'stop'    — mic stopped;         no cooldown, generates final batch
type RefreshTrigger = 'manual' | 'auto' | 'stop'

const SETTINGS_STORAGE_KEY = 'twinmind_assignment_settings'
const TRANSCRIPT_NOISE_PATTERNS = new Set([
  'you', 'thank you', 'thanks', 'thanks for watching', 'bye', 'bye bye', 'silence',
])

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  meetingContext: '',
  suggestionIntervalMs: 30_000,
  suggestionContextChars: 4_500,
  chatContextChars: 8_500,
  noiseGateEnabled: false,
  noiseGateMinKb: 25,
  liveSuggestionsPrompt: `Act as a real-time meeting copilot.

Your job is to generate exactly 3 high-value, contextually grounded suggestions based on the current transcript.

BEFORE generating, identify:
- What is the main topic being discussed right now?
- What is the most likely next need of the participant?
- What gaps, risks, decisions, or action items are present in the transcript?

WHEN generating:
1. Make each suggestion immediately useful in the live conversation — not generic.
2. Ground every suggestion strictly in the actual transcript. Do not invent context.
3. Connect to earlier points, decisions, risks, deadlines, or unresolved questions when relevant.
4. Vary the type: question to ask, answer to give, fact to check, talking point, clarification, or useful output (summary, action items, minutes, email, checklist, risk list, decision log).
5. If context is incomplete, make the suggestion conditional — do not speculate.

GUARDRAILS:
- Every suggestion must be directly tied to what is in the transcript — no invented scenarios
- No generic or obvious suggestions that could apply to any meeting
- Each suggestion must differ in type and angle from the others
- Previews must be specific, concise (1–2 sentences), and immediately actionable

Output MUST be valid JSON only:
{
  "suggestions": [
    { "title": "short title", "preview": "1-2 sentence useful preview", "intent": "question|answer|fact_check|talking_point|clarify" }
  ]
}

Return exactly 3 suggestions.`,
  detailAnswerPrompt: `Act as a focused, professional assistant expanding a meeting suggestion into a detailed, actionable answer.

BEFORE expanding, identify:
- What is the real intent behind this suggestion?
- What transcript context directly supports it?
- What is the most useful, grounded answer right now?

WHEN expanding:
1. Lead with the direct answer or key takeaway in the first sentence.
2. Stay tightly focused on the suggestion topic — do not introduce unrelated detail.
3. Ground every point in the transcript. Clearly label inferences (e.g. "This appears to suggest…").
4. If information is missing or not in the transcript, say so explicitly — do not fill gaps with assumptions.
5. Distinguish between what was stated, what is inferred, and what is unknown.
6. End with concrete, actionable next steps tied to what was actually discussed.

USE THIS EXACT STRUCTURE:
## Summary
One clear sentence — the direct answer or key takeaway.

## Key Details
* Bullet points grounded in the transcript. Label inferences clearly.

## Action Items
1. Numbered, concrete next steps that can be acted on immediately.

STYLE RULES:
- Avoid markdown tables, pipes (|), or long horizontal separators (---)
- Wrap important dates, deadlines, or numbers as [HIGHLIGHT: value]
- For writing output (email, summary, minutes), produce polished, ready-to-use content

QUALITY CHECK before finalizing:
- Did I answer the actual suggestion intent?
- Is every point grounded in the transcript or clearly labelled?
- Did I avoid invented facts or unsupported assumptions?`,
  chatPrompt: `Act as a focused, professional meeting copilot assistant.

Your job is to answer the user's request clearly, accurately, and without drifting off topic.

BEFORE answering, identify:
- What exactly is the user asking?
- What is the direct answer?
- What transcript context is relevant to this request?

WHEN answering:
1. Lead with the direct answer or key takeaway in the first 1–2 lines.
2. Stay tightly focused on the requested topic — do not expand scope unless asked.
3. Only include information that directly supports the request.
4. Use the transcript as the primary source. Use general knowledge only when necessary and label it clearly.
5. If information is missing or uncertain, state it explicitly — do not fill gaps with assumptions.
6. Distinguish between what was stated, what is inferred, and what is unknown.
7. End with a next step or suggestion only if directly relevant.

STRUCTURE RULES:
- Use simple Markdown headers (##), bullet points (*), or numbered lists when useful
- Avoid markdown tables, pipes (|), or long horizontal separators (---)
- Preferred structure: Summary → Key Details → Action Items
- For writing requests (meeting minutes, email, summary), produce polished, ready-to-use output

QUALITY CHECK before finalizing:
- Did I answer the actual question?
- Did I stay on topic throughout?
- Did I avoid unsupported claims?
- Is every sentence relevant and useful?`,
}

const nowIso = () => new Date().toISOString()
const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TRANSCRIPT_PREVIEW_INTERVAL_MS = 5_000
const TRANSCRIPT_COMMIT_INTERVAL_MS = 30_000
const REFRESH_COOLDOWN_MS = 10_000
// Two consecutive commit cycles (~60s) with no real speech = silence.
const SILENCE_THRESHOLD_MS = 60_000
// A 30s commit must contain at least this many words to count as real speech.
// Filters out stray words, coughs, or single acknowledgements that aren't real content.
const MIN_REAL_COMMIT_WORDS = 5
// Minimum raw context characters required before calling the suggestion API.
// Prevents hallucinated suggestions on thin transcripts (e.g. "Okay. Okay. All right.").
const MIN_SUGGESTION_CONTEXT_CHARS = 300
// Minimum new characters added since the last suggestion generation before allowing manual reload.
// Prevents redundant API calls when the transcript hasn't changed meaningfully.
const MIN_NEW_CHARS_FOR_REFRESH = 150

const intentLabelMap: Record<string, string> = {
  question: 'Question to ask',
  question_to_ask: 'Question to ask',
  answer: 'Answer',
  talking_point: 'Talking point',
  fact_check: 'Fact check',
  clarify: 'Talking point',
}

const ATTRIBUTION_RE = /^[-*•_\s]*(prepared by|generated by|written by|document prepared|meeting notes prepared|copilot)/i

const isDailyLimitError = (msg: string) =>
  msg.includes('Daily token limit') || msg.includes('tokens per day')

const extractWaitTime = (msg: string): string => {
  const m = /try again in (.+?)\.?$/i.exec(msg)
  return m ? ` Try again in ${m[1]}.` : ''
}

const sanitizeAssistantMarkdown = (raw: string) => {
  return raw
    .split('\n')
    .filter((line) => !(line.includes('|') && line.split('|').length >= 3))
    .map((line) => (line.trim() === '---' ? '' : line))
    .filter((line) => !ATTRIBUTION_RE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const vibeKeywords: Record<Vibe, string[]> = {
  positive: [
    // praise & recognition
    'congratulations', 'congrats', 'well done', 'good work', 'great job', 'nice work',
    'excellent work', 'outstanding', 'brilliant', 'impressive', 'kudos', 'bravo',
    'nailed it', 'crushed it', 'killed it', 'spot on', 'well said', 'great point',
    'good point', 'love it', 'fantastic', 'amazing', 'awesome', 'superb', 'stellar',
    // delivery & progress
    'shipped', 'launched', 'released', 'deployed', 'delivered', 'completed', 'finished',
    'resolved', 'done', 'approved', 'merged', 'signed off', 'green light', 'on track',
    // agreement & positivity
    'great', 'good', 'excellent', 'progress', 'success', 'confident', 'working',
    'agreed', 'absolutely', 'exactly', 'perfect',
  ],
  neutral: [
    'agenda', 'meeting', 'review', 'discussion', 'update', 'consider', 'timeline',
    'roadmap', 'milestone', 'checkpoint', 'follow-up', 'action item', 'next steps',
    'question', 'feedback', 'plan', 'schedule', 'walkthrough', 'overview', 'clarify',
    'presentation', 'handoff', 'sync', 'standup', 'retrospective', 'sprint',
  ],
  critical: [
    'blocked', 'blocker', 'urgent', 'issue', 'bug', 'crash', 'incident', 'risk',
    'delay', 'outage', 'broken', 'error', 'down', 'failed', 'failure', 'critical',
    'problem', 'regression', 'hotfix', 'rollback', 'fix', 'production', 'stuck',
    'concern', 'escalate', 'escalation', 'behind schedule', 'overdue', 'missed',
    'off track', 'red flag', 'showstopper', 'deadline', 'at risk', 'not working',
  ],
}

const getVibeFromText = (text: string): Vibe => {
  const lower = text.toLowerCase()
  let positive = 0
  let critical = 0
  for (const word of vibeKeywords.positive) if (lower.includes(word)) positive += 1
  for (const word of vibeKeywords.critical) if (lower.includes(word)) critical += 1
  if (critical > 0 && critical >= positive) return 'critical'
  if (positive >= 2) return 'positive'
  return 'neutral'
}

const pickSupportedMimeType = () => {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}

function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) }
    } catch {
      return DEFAULT_SETTINGS
    }
  })
  const [activeScreen, setActiveScreen] = useState<'main' | 'settings'>('main')
  const [isRecording, setIsRecording] = useState(false)
  // True after the first 30s commit produces real transcript text.
  // Gates the suggestion timer, reload button, and silence detection.
  const [hasFirstRealCommit, setHasFirstRealCommit] = useState(false)
  const [isSuggestionTimerActive, setIsSuggestionTimerActive] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSendingChat, setIsSendingChat] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [suggestionBatches, setSuggestionBatches] = useState<SuggestionBatch[]>([])
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [livePreview, setLivePreview] = useState<TranscriptEntry[]>([])
  const [chatInput, setChatInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null)
  const [nextRefreshInSec, setNextRefreshInSec] = useState(Math.ceil(DEFAULT_SETTINGS.suggestionIntervalMs / 1000))
  const [vibe, setVibe] = useState<Vibe>('neutral')

  // Ref mirror of settings — lets timer callbacks read fresh values without stale closures.
  const settingsRef = useRef(settings)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sessionStartRef = useRef<Date | null>(null)
  const shouldRestartRef = useRef(false)
  const isRecordingRef = useRef(false)
  // Ref mirror updated synchronously in commitPendingTranscript — no useEffect mirror needed.
  const hasFirstRealCommitRef = useRef(false)
  // Epoch ms of last 30s commit that produced real text. Used for silence detection.
  const lastRealCommitAtRef = useRef(0)
  const lastRefreshAtRef = useRef(0)
  // Context length at the time of the last successful suggestion generation.
  // Used to detect whether enough new content has arrived before allowing manual reload.
  const lastSuggestionContextLengthRef = useRef(0)
  const inFlightTranscriptionsRef = useRef<Promise<void>[]>([])
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)
  const suggestionsIntervalRef = useRef<number | null>(null)
  const transcriptCommitIntervalRef = useRef<number | null>(null)
  const countdownIntervalRef = useRef<number | null>(null)
  const silenceWatchRef = useRef<number | null>(null)
  const transcriptTextRef = useRef('')
  const pendingTranscriptPartsRef = useRef<string[]>([])

  // ── Persistence ──
  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    settingsRef.current = settings
  }, [settings])

  // ── Ref mirror ──
  useEffect(() => { isRecordingRef.current = isRecording }, [isRecording])

  // ── Transcript text ref: authoritative rebuild from committed state ──
  useEffect(() => {
    transcriptTextRef.current = transcript
      .map((line) => `[${new Date(line.createdAt).toLocaleTimeString()}] ${line.text}`)
      .join('\n')
  }, [transcript])

  // ── Vibe: recalculate whenever committed transcript changes ──
  useEffect(() => {
    setVibe(getVibeFromText(transcriptTextRef.current.slice(-2_000)))
  }, [transcript])

  // ── Auto-scroll ──
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [transcript, livePreview])

  // ── Suggestion timer: starts only after the first real 30s commit.
  //    When hasFirstRealCommit first flips true, fire one batch immediately so the
  //    user sees suggestions at ~30s rather than waiting a full extra interval (~60s).
  //    Re-runs when the interval setting changes so the new cadence takes effect. ──
  const prevHasFirstRealCommitRef = useRef(false)
  useEffect(() => {
    if (!isRecording || !hasFirstRealCommit) return
    const isFirstCommit = !prevHasFirstRealCommitRef.current
    prevHasFirstRealCommitRef.current = true
    startSuggestionTimer()
    if (isFirstCommit) void refreshSuggestions('auto')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, hasFirstRealCommit, settings.suggestionIntervalMs])

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => { void stopRecording() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Timer helpers ──

  function stopSuggestionTimer() {
    if (suggestionsIntervalRef.current) {
      window.clearInterval(suggestionsIntervalRef.current)
      suggestionsIntervalRef.current = null
    }
    if (countdownIntervalRef.current) {
      window.clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    setIsSuggestionTimerActive(false)
  }

  function stopTranscriptCommitTimer() {
    if (transcriptCommitIntervalRef.current) {
      window.clearInterval(transcriptCommitIntervalRef.current)
      transcriptCommitIntervalRef.current = null
    }
  }

  function stopSilenceWatch() {
    if (silenceWatchRef.current) {
      window.clearInterval(silenceWatchRef.current)
      silenceWatchRef.current = null
    }
  }

  function startSuggestionTimer() {
    stopSuggestionTimer()
    const intervalMs = settingsRef.current.suggestionIntervalMs
    setNextRefreshInSec(Math.ceil(intervalMs / 1000))
    setIsSuggestionTimerActive(true)
    suggestionsIntervalRef.current = window.setInterval(() => {
      if (isRecordingRef.current) void refreshSuggestions('auto')
    }, intervalMs)
    countdownIntervalRef.current = window.setInterval(() => {
      setNextRefreshInSec((prev) => {
        const next = prev - 1
        if (next <= 0) return Math.ceil(settingsRef.current.suggestionIntervalMs / 1000)
        return next
      })
    }, 1_000)
  }

  // Watches committed-transcript timestamps for silence.
  // Silence = no real 30s commit for SILENCE_THRESHOLD_MS.
  // Pauses the suggestion timer when silent; auto-resumes when speech returns.
  function startSilenceWatch() {
    stopSilenceWatch()
    silenceWatchRef.current = window.setInterval(() => {
      if (!isRecordingRef.current || !hasFirstRealCommitRef.current) return
      const silent = Date.now() - lastRealCommitAtRef.current >= SILENCE_THRESHOLD_MS
      const timerRunning = suggestionsIntervalRef.current !== null
      if (silent && timerRunning) {
        stopSuggestionTimer()
        setNextRefreshInSec(Math.ceil(settingsRef.current.suggestionIntervalMs / 1000))
      } else if (!silent && !timerRunning) {
        startSuggestionTimer()
      }
    }, 1_000)
  }

  // ── Transcript helpers ──

  const commitPendingTranscript = () => {
    const merged = pendingTranscriptPartsRef.current.join(' ').trim()
    pendingTranscriptPartsRef.current = []
    if (!merged) return
    const entry = { id: makeId(), text: merged, createdAt: nowIso() }
    // Sync ref update so refreshSuggestions sees latest text immediately —
    // the useEffect rebuild fires asynchronously after setState.
    const line = `[${new Date(entry.createdAt).toLocaleTimeString()}] ${entry.text}`
    transcriptTextRef.current = transcriptTextRef.current
      ? `${transcriptTextRef.current}\n${line}`
      : line
    // Only open the suggestion gate and advance the speech clock when this commit
    // contains enough words. A stray word or two-word fragment is shown in the
    // transcript for the user's reference but does not trigger the suggestion system.
    const wordCount = merged.split(/\s+/).filter(Boolean).length
    if (wordCount >= MIN_REAL_COMMIT_WORDS) {
      lastRealCommitAtRef.current = Date.now()
      if (!hasFirstRealCommitRef.current) {
        hasFirstRealCommitRef.current = true
        setHasFirstRealCommit(true)
      }
    }
    setTranscript((prev) => [...prev, entry])
    setLivePreview([])
  }

  function startTranscriptCommitTimer() {
    stopTranscriptCommitTimer()
    transcriptCommitIntervalRef.current = window.setInterval(() => {
      void Promise.all(inFlightTranscriptionsRef.current).then(commitPendingTranscript)
    }, TRANSCRIPT_COMMIT_INTERVAL_MS)
  }

  const addTranscriptEntry = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Filter Whisper silence hallucinations: anything with fewer than 2 actual letters
    // catches ".", ".." etc. that encode to non-empty strings but carry no speech content.
    if (trimmed.replace(/[^a-zA-Z]/g, '').length < 2) return
    const normalized = trimmed.toLowerCase().replace(/[^\w\s]/g, '').trim()
    if (trimmed.split(/\s+/).length <= 3 && TRANSCRIPT_NOISE_PATTERNS.has(normalized)) return
    setLivePreview((prev) => [...prev.slice(-7), { id: makeId(), text: trimmed, createdAt: nowIso() }])
    pendingTranscriptPartsRef.current.push(trimmed)
  }

  // ── Audio pipeline ──

  const handleAudioBlob = (blob: Blob) => {
    if (!settings.apiKey || blob.size < 10_000) return
    if (settings.noiseGateEnabled && blob.size < settings.noiseGateMinKb * 1024) return

    const job = (async () => {
      const text = await transcribeAudioChunk(settings.apiKey, blob)
      if (text) addTranscriptEntry(text)
    })().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Transcription failed.')
    })

    inFlightTranscriptionsRef.current.push(job)
    job.finally(() => {
      inFlightTranscriptionsRef.current = inFlightTranscriptionsRef.current.filter((p) => p !== job)
    })
  }

  const flushCurrentChunk = (): Promise<void> => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state !== 'recording') return Promise.resolve()
    return new Promise<void>((resolve) => {
      recorder.addEventListener('dataavailable', () => resolve(), { once: true })
      recorder.stop()
    })
  }

  const flushAndCommitAllPending = async () => {
    await flushCurrentChunk()
    await Promise.all(inFlightTranscriptionsRef.current)
    commitPendingTranscript()
  }

  const launchRecordingCycle = (stream: MediaStream, mimeType: string) => {
    if (!shouldRestartRef.current) return
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    mediaRecorderRef.current = recorder
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) handleAudioBlob(event.data)
    }
    recorder.onstop = () => {
      if (shouldRestartRef.current) window.setTimeout(() => launchRecordingCycle(stream, mimeType), 100)
    }
    recorder.start()
    window.setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop()
    }, TRANSCRIPT_PREVIEW_INTERVAL_MS)
  }

  // Returns a metadata block prepended to every AI context string so the model
  // always has the authoritative date/time — never needs to infer or guess it.
  const buildSessionHeader = (): string => {
    const d = sessionStartRef.current ?? new Date()
    const date = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return `[Session metadata]\nDate: ${date}\nStart time: ${time}\nTimezone: ${tz}\n\n`
  }

  // ── Recording lifecycle ──

  const startRecording = async () => {
    if (!settings.apiKey) {
      setError('Add your Groq API key in Settings first.')
      return
    }
    try {
      setError(null)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      shouldRestartRef.current = true
      sessionStartRef.current = new Date()
      hasFirstRealCommitRef.current = false
      prevHasFirstRealCommitRef.current = false
      lastSuggestionContextLengthRef.current = 0
      lastRealCommitAtRef.current = 0
      setHasFirstRealCommit(false)
      setIsSuggestionTimerActive(false)
      setNextRefreshInSec(Math.ceil(settings.suggestionIntervalMs / 1000))
      launchRecordingCycle(stream, pickSupportedMimeType())
      startTranscriptCommitTimer()
      startSilenceWatch()
      setIsRecording(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start microphone.')
    }
  }

  async function stopRecording() {
    shouldRestartRef.current = false
    stopSilenceWatch()
    stopTranscriptCommitTimer()
    stopSuggestionTimer()
    await flushAndCommitAllPending()
    mediaRecorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    // Capture before resetting — used to gate the final stop-trigger suggestion batch.
    const hadRealContent = hasFirstRealCommitRef.current
    hasFirstRealCommitRef.current = false
    lastRealCommitAtRef.current = 0
    setHasFirstRealCommit(false)
    setIsRecording(false)
    // Auto-generate one final batch only if meaningful speech was recorded.
    // hadRealContent guards against sessions that only had noise/single words.
    if (hadRealContent && transcriptTextRef.current.trim()) void refreshSuggestions('stop')
  }

  const onToggleRecording = () => {
    if (isRecording) void stopRecording()
    else void startRecording()
  }

  // ── Suggestions ──

  const refreshSuggestions = async (trigger: RefreshTrigger = 'manual') => {
    if (!settings.apiKey) {
      setError('Add your Groq API key in Settings first.')
      return
    }
    if (isRefreshing) {
      if (trigger === 'manual') setRefreshStatus('Suggestions are already updating…')
      return
    }

    // Cooldown and change detection only apply to manual clicks.
    if (trigger === 'manual') {
      const msSinceLast = Date.now() - lastRefreshAtRef.current
      if (msSinceLast < REFRESH_COOLDOWN_MS) {
        setRefreshStatus('Suggestions are up to date. Auto-refresh will trigger when new context arrives.')
        return
      }
      lastRefreshAtRef.current = Date.now()
    }

    setError(null)
    setRefreshStatus(null)
    setIsRefreshing(true)
    try {
      // Only flush when a real commit happened recently (speech is active).
      // During silence, flushing produces a header-only WebM stub that Whisper rejects.
      const speakingRecently = Date.now() - lastRealCommitAtRef.current < SILENCE_THRESHOLD_MS
      if (isRecordingRef.current && speakingRecently) await flushAndCommitAllPending()

      // Include any pending parts not yet committed by the 30s timer.
      const pendingText = pendingTranscriptPartsRef.current.join(' ').trim()
      const rawContext = pendingText
        ? `${transcriptTextRef.current}\n${pendingText}`
        : transcriptTextRef.current
      const context = buildSessionHeader() + rawContext.slice(-settingsRef.current.suggestionContextChars)
      if (context.length < MIN_SUGGESTION_CONTEXT_CHARS) {
        if (trigger === 'manual') setRefreshStatus('Not enough transcript content yet for suggestions.')
        return
      }

      // For manual reloads: skip if the transcript hasn't grown enough since last generation.
      if (trigger === 'manual' && lastSuggestionContextLengthRef.current > 0) {
        const newChars = context.length - lastSuggestionContextLengthRef.current
        if (newChars < MIN_NEW_CHARS_FOR_REFRESH) {
          const timerPaused = suggestionsIntervalRef.current === null
          setRefreshStatus(
            timerPaused
              ? 'No major new discussion points yet. Auto-refresh is paused — waiting for speech.'
              : 'No major new discussion points yet. Auto-refresh will trigger when more context arrives.'
          )
          return
        }
      }

      const previousTitles = suggestionBatches
        .slice(0, 3)
        .flatMap((b) => b.suggestions.map((s) => s.title))
      const t0 = Date.now()
      const suggestions = await createLiveSuggestions(
        settings.apiKey,
        settings.liveSuggestionsPrompt,
        context,
        settings.meetingContext,
        previousTitles,
      )
      if (suggestions.length < 2) {
        if (trigger === 'manual') setRefreshStatus('Not enough distinct content for a new suggestion batch yet.')
        return
      }
      lastSuggestionContextLengthRef.current = context.length
      setSuggestionBatches((prev) => [
        {
          id: makeId(),
          createdAt: nowIso(),
          latencyMs: Date.now() - t0,
          suggestions: suggestions.map((s) => ({ ...s, id: makeId() })),
        },
        ...prev,
      ])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to refresh suggestions.'
      if (isDailyLimitError(msg)) {
        stopSuggestionTimer()
        setRefreshStatus(`Groq daily quota reached — suggestions paused.${extractWaitTime(msg)} The quota resets automatically; try again later.`)
      } else {
        setError(msg)
      }
    } finally {
      setIsRefreshing(false)
    }
  }

  // ── Chat ──

  const addChatMessage = (role: ChatRole, content: string, latencyMs?: number, contextTag?: string) => {
    setChatMessages((prev) => [...prev, { id: makeId(), role, content, createdAt: nowIso(), latencyMs, contextTag }])
  }

  const handleSuggestionClick = async (suggestion: Suggestion) => {
    if (!settings.apiKey) { setError('Add your Groq API key in Settings first.'); return }
    const contextTag = intentLabelMap[suggestion.intent] || 'Suggestion'
    addChatMessage('user', suggestion.preview, undefined, contextTag)
    setIsSendingChat(true)
    try {
      const t0 = Date.now()
      const reply = await createDetailedSuggestionAnswer(
        settings.apiKey, settings.detailAnswerPrompt,
        buildSessionHeader() + transcriptTextRef.current, suggestion, settings.meetingContext,
      )
      addChatMessage('assistant', sanitizeAssistantMarkdown(reply), Date.now() - t0, contextTag)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to expand suggestion.'
      if (isDailyLimitError(msg)) {
        addChatMessage('assistant', `Groq daily quota reached — unable to expand this suggestion.${extractWaitTime(msg)} Suggestions are also paused. The quota resets automatically; try again later.`)
      } else {
        setError(msg)
      }
    } finally {
      setIsSendingChat(false)
    }
  }

  const handleChatSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!settings.apiKey) { setError('Add your Groq API key in Settings first.'); return }
    const question = chatInput.trim()
    if (!question) return
    setChatInput('')
    addChatMessage('user', question)
    setIsSendingChat(true)
    try {
      const t0 = Date.now()
      const context = buildSessionHeader() + transcriptTextRef.current.slice(-settings.chatContextChars)
      const history = [...chatMessages, { id: makeId(), role: 'user' as const, content: question, createdAt: nowIso() }]
      const reply = await createAssistantChatReply(settings.apiKey, settings.chatPrompt, context, history, settings.meetingContext)
      addChatMessage('assistant', sanitizeAssistantMarkdown(reply), Date.now() - t0)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send chat message.'
      if (isDailyLimitError(msg)) {
        addChatMessage('assistant', `Groq daily quota reached — unable to answer right now.${extractWaitTime(msg)} The quota resets automatically; try again later.`)
      } else {
        setError(msg)
      }
    } finally {
      setIsSendingChat(false)
    }
  }

  const handleExport = () => {
    const payload = buildExportPayload({ transcript, livePreview, suggestionBatches, chatMessages })
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `twinmind-session-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Derived UI values ──
  const reloadDisabled = isRefreshing || !isRecording || !hasFirstRealCommit
  const countdownLabel = (() => {
    if (!isRecording || !hasFirstRealCommit) return `auto-refresh in ${Math.ceil(settings.suggestionIntervalMs / 1000)}s`
    if (!isSuggestionTimerActive) return 'Paused — waiting for speech'
    return `auto-refresh in ${nextRefreshInSec}s`
  })()

  return (
    <main className="app-shell">
      <header className="toolbar">
        <h1>TwinMind Live Suggestions</h1>
        <div className="toolbar-actions">
          <button onClick={handleExport}>Export Session</button>
          <button onClick={() => setActiveScreen('settings')}>Settings</button>
        </div>
      </header>
      <section className="status-row">
        <div className={`vibe-pill ${vibe}`}>
          <span className="dot" />
          <span>Vibe: {vibe}</span>
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}
      {refreshStatus && !error ? <p className="status-info">{refreshStatus}</p> : null}

      {activeScreen === 'settings' ? (
        <section className="settings-screen">
          <div className="settings-header">
            <h2>Settings</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="link-button"
                onClick={() => setSettings((prev) => ({
                  ...prev,
                  liveSuggestionsPrompt: DEFAULT_SETTINGS.liveSuggestionsPrompt,
                  detailAnswerPrompt: DEFAULT_SETTINGS.detailAnswerPrompt,
                  chatPrompt: DEFAULT_SETTINGS.chatPrompt,
                }))}
              >
                Reset prompts
              </button>
              <button className="settings-close" onClick={() => setActiveScreen('main')}>Back</button>
            </div>
          </div>
          <label>
            Groq API Key
            <input
              type="password"
              value={settings.apiKey}
              onChange={(e) => setSettings((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder="gsk_..."
            />
          </label>
          <label>
            Meeting Context <span className="label-hint">(agenda, participants, background — injected into every AI call)</span>
            <textarea
              rows={4}
              value={settings.meetingContext}
              onChange={(e) => setSettings((prev) => ({ ...prev, meetingContext: e.target.value }))}
              placeholder="e.g. Q3 planning call with engineering leads. Agenda: roadmap priorities, resource allocation, launch dates."
            />
          </label>
          <div className="grid-3">
            <label>
              Suggestion interval (ms) <span className="label-hint">min 10 000</span>
              <input
                type="number"
                min={10_000}
                value={settings.suggestionIntervalMs}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, suggestionIntervalMs: Math.max(10_000, Number(e.target.value) || 30_000) }))
                }
              />
            </label>
            <label>
              Suggestion context chars
              <input
                type="number"
                value={settings.suggestionContextChars}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, suggestionContextChars: Number(e.target.value) || 4_500 }))
                }
              />
            </label>
            <label>
              Chat context chars
              <input
                type="number"
                value={settings.chatContextChars}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, chatContextChars: Number(e.target.value) || 8_500 }))
                }
              />
            </label>
          </div>
          <div className="grid-3">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.noiseGateEnabled}
                onChange={(e) => setSettings((prev) => ({ ...prev, noiseGateEnabled: e.target.checked }))}
              />
              Noise gate <span className="label-hint">(skip silent chunks)</span>
            </label>
            <label>
              Min chunk size (KB) <span className="label-hint">when noise gate on</span>
              <input
                type="number"
                min={10}
                max={100}
                value={settings.noiseGateMinKb}
                disabled={!settings.noiseGateEnabled}
                onChange={(e) => setSettings((prev) => ({ ...prev, noiseGateMinKb: Number(e.target.value) || 25 }))}
              />
            </label>
          </div>
          <label>
            Live suggestions prompt
            <textarea
              rows={8}
              value={settings.liveSuggestionsPrompt}
              onChange={(e) => setSettings((prev) => ({ ...prev, liveSuggestionsPrompt: e.target.value }))}
            />
          </label>
          <label>
            Suggestion detail prompt
            <textarea
              rows={7}
              value={settings.detailAnswerPrompt}
              onChange={(e) => setSettings((prev) => ({ ...prev, detailAnswerPrompt: e.target.value }))}
            />
          </label>
          <label>
            Chat prompt
            <textarea
              rows={6}
              value={settings.chatPrompt}
              onChange={(e) => setSettings((prev) => ({ ...prev, chatPrompt: e.target.value }))}
            />
          </label>
        </section>
      ) : null}

      {activeScreen === 'main' ? (
        <section className="columns">
          {/* ── Column 1: Transcript ── */}
          <div className="column">
            <div className="panel-title-row">
              <h2>1. MIC &amp; TRANSCRIPT</h2>
              <span className={`status-chip ${isRecording ? 'live' : ''}`}>{isRecording ? 'recording' : 'idle'}</span>
            </div>
            <div className="panel col-panel">
              <div className="col-subhead split">
                <span>{isRecording ? 'Listening… transcript updates every 30s.' : 'Mic is off.'}</span>
                <button
                  className={`link-button${isRecording ? '' : ' resume-btn'}`}
                  onClick={onToggleRecording}
                >
                  {isRecording ? '⏹ Stop Mic' : '▶ Start Mic'}
                </button>
              </div>
              <div className="col-scroll">
                {transcript.length === 0 ? <p className="muted">Confirmed transcript appears every ~30 seconds.</p> : null}
                {transcript.map((line) => (
                  <div key={line.id} className="transcript-line">
                    <span>{new Date(line.createdAt).toLocaleTimeString()}</span>
                    <p>{line.text}</p>
                  </div>
                ))}
                {livePreview.length > 0 ? <p className="muted preview-label">Live preview (~5s, unconfirmed)</p> : null}
                {livePreview.map((line) => (
                  <div key={line.id} className="transcript-line preview">
                    <span>{new Date(line.createdAt).toLocaleTimeString()}</span>
                    <p>{line.text}</p>
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </div>
            </div>
          </div>

          {/* ── Column 2: Live Suggestions ── */}
          <div className="column">
            <div className="panel-title-row">
              <h2>2. LIVE SUGGESTIONS</h2>
              <span className="status-chip">{suggestionBatches.length} batches</span>
            </div>
            <div className="panel col-panel">
              <div className="col-subhead split">
                <button
                  className="link-button"
                  onClick={() => void refreshSuggestions('manual')}
                  disabled={reloadDisabled}
                >
                  {isRefreshing ? '↻ Reloading…' : '↻ Reload suggestions'}
                </button>
                <span>{countdownLabel}</span>
              </div>
              <div className="col-scroll">
                {suggestionBatches.length === 0 ? <p className="muted">Suggestion batches appear on each refresh.</p> : null}
                {suggestionBatches.map((batch, index) => (
                  <div key={batch.id} className="suggestion-batch">
                    <h3>
                      Batch {suggestionBatches.length - index} · {new Date(batch.createdAt).toLocaleTimeString()}
                      <span className="latency">{(batch.latencyMs / 1000).toFixed(1)}s</span>
                    </h3>
                    {batch.suggestions.map((suggestion) => (
                      <button
                        key={suggestion.id}
                        className="suggestion-card"
                        onClick={() => void handleSuggestionClick(suggestion)}
                      >
                        <span className={`intent-pill ${suggestion.intent}`}>
                          {(intentLabelMap[suggestion.intent] || 'Suggestion').toUpperCase()}
                        </span>
                        <p>{suggestion.preview}</p>
                        <small>{suggestion.title}</small>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Column 3: Chat ── */}
          <div className="column">
            <div className="panel-title-row">
              <h2>3. CHAT (DETAILED ANSWERS)</h2>
              <span className="status-chip">session only</span>
            </div>
            <div className="panel col-panel">
              <div className="col-scroll chat-messages">
                {chatMessages.length === 0 ? <p className="muted">Click a suggestion or ask a question below.</p> : null}
                {chatMessages.map((message) => (
                  <div key={message.id} className={`chat-message ${message.role}`}>
                    <div className="meta">
                      <strong>
                        {message.role === 'user' ? 'YOU' : 'ASSISTANT'}
                        {message.contextTag ? ` · ${message.contextTag}` : ''}
                      </strong>
                      <span>
                        {new Date(message.createdAt).toLocaleTimeString()}
                        {message.latencyMs != null ? (
                          <span className="latency">{(message.latencyMs / 1000).toFixed(1)}s</span>
                        ) : null}
                      </span>
                    </div>
                    <div className="markdown-body">
                      <ReactMarkdown>{message.content}</ReactMarkdown>
                    </div>
                  </div>
                ))}
              </div>
              <form onSubmit={handleChatSubmit} className="chat-form">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask anything about this meeting..."
                />
                <button type="submit" disabled={isSendingChat}>
                  {isSendingChat ? 'Sending...' : 'Send'}
                </button>
              </form>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  )
}

export default App
