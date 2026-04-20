import { useEffect, useRef, useState } from 'react'
import './App.css'
import type { AppSettings, Vibe } from './types'
import { SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS, intentLabelMap, MIN_STOP_CONTEXT_CHARS } from './constants'
import { getVibeFromText } from './lib/utils'
import { buildExportPayload } from './lib/groq'
import { useTranscript } from './hooks/useTranscript'
import { useAudioRecorder } from './hooks/useAudioRecorder'
import { useSuggestions } from './hooks/useSuggestions'
import { useChat } from './hooks/useChat'
import TranscriptPanel from './components/TranscriptPanel'
import SuggestionsPanel from './components/SuggestionsPanel'
import ChatPanel from './components/ChatPanel'
import SettingsScreen from './components/SettingsScreen'

function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) } }
    catch { return DEFAULT_SETTINGS }
  })
  const [activeScreen, setActiveScreen] = useState<'main' | 'settings'>('main')
  const [error, setError] = useState<string | null>(null)
  const [vibe, setVibe] = useState<Vibe>('neutral')

  // Ref mirror of settings so hooks with interval callbacks always read fresh values.
  const settingsRef = useRef(settings)
  // Tracks transcript length at the last stop-trigger suggestion so repeated
  // stop/start cycles with no new speech don't re-fire on stale content.
  const lastStopTriggerLengthRef = useRef(0)
  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    settingsRef.current = settings
  }, [settings])

  // ── Domain hooks ──

  const transcript = useTranscript()

  const recorder = useAudioRecorder({
    settingsRef,
    onTranscription: transcript.addTranscriptEntry,
    commitPendingTranscript: transcript.commitPendingTranscript,
    onError: setError,
  })

  const suggestions = useSuggestions({
    settingsRef,
    isRecording: recorder.isRecording,
    isRecordingRef: recorder.isRecordingRef,
    hasFirstRealCommit: transcript.hasFirstRealCommit,
    hasFirstRealCommitRef: transcript.hasFirstRealCommitRef,
    lastRealCommitAtRef: transcript.lastRealCommitAtRef,
    transcriptTextRef: transcript.transcriptTextRef,
    pendingTranscriptPartsRef: transcript.pendingTranscriptPartsRef,
    flushAndCommitAllPending: recorder.flushAndCommitAllPending,
    sessionStartRef: recorder.sessionStartRef,
    onError: setError,
    onClearError: () => setError(null),
  })

  const chat = useChat({
    settingsRef,
    transcriptTextRef: transcript.transcriptTextRef,
    sessionStartRef: recorder.sessionStartRef,
    onError: setError,
  })

  // ── Vibe: recalculate whenever committed transcript changes ──
  useEffect(() => {
    setVibe(getVibeFromText(transcript.transcriptTextRef.current.slice(-2_000)))
  }, [transcript.transcript])

  // ── Recording lifecycle ──

  const handleStart = async () => {
    setError(null)
    transcript.resetSession()
    suggestions.resetSession()
    await recorder.start()
  }

  const handleStop = async () => {
    // Stop timers first so no in-flight auto-refresh runs after stop.
    suggestions.stopAllTimers()
    // Flush audio, wait for transcriptions, do final commit.
    await recorder.stop()
    // Capture transcript length and full text AFTER flush/commit, BEFORE reset.
    // The snapshot is passed directly to the stop-trigger so it has complete
    // context even after resetSession clears the session base offset.
    const transcriptLength = transcript.transcriptTextRef.current.trim().length
    const snapshotText = transcript.transcriptTextRef.current
    // Only count chars added since the last stop-trigger so repeated stop/start
    // cycles with no new speech don't re-fire on already-processed content.
    const newChars = transcriptLength - lastStopTriggerLengthRef.current
    // Reset speech-tracking state for both hooks.
    transcript.resetSession()
    suggestions.resetSession()
    // Fire one final suggestion batch only if enough new content was recorded.
    if (newChars >= MIN_STOP_CONTEXT_CHARS) {
      lastStopTriggerLengthRef.current = transcriptLength
      void suggestions.refreshSuggestions('stop', snapshotText)
    }
  }

  // ── Export ──

  const handleExport = () => {
    const payload = buildExportPayload({
      transcript: transcript.transcript,
      livePreview: transcript.livePreview,
      suggestionBatches: suggestions.suggestionBatches,
      chatMessages: chat.chatMessages,
    })
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `twinmind-session-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => { void recorder.stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      {suggestions.refreshStatus && !error ? (
        <p className="status-info">{suggestions.refreshStatus}</p>
      ) : null}

      {activeScreen === 'settings' ? (
        <SettingsScreen
          settings={settings}
          onSettingsChange={setSettings}
          onClose={() => setActiveScreen('main')}
        />
      ) : null}

      {activeScreen === 'main' ? (
        <section className="columns">
          <TranscriptPanel
            transcript={transcript.transcript}
            livePreview={transcript.livePreview}
            isRecording={recorder.isRecording}
            transcriptEndRef={transcript.transcriptEndRef}
            onToggleRecording={recorder.isRecording ? handleStop : handleStart}
          />
          <SuggestionsPanel
            suggestionBatches={suggestions.suggestionBatches}
            isRefreshing={suggestions.isRefreshing}
            reloadDisabled={suggestions.reloadDisabled}
            countdownLabel={suggestions.countdownLabel}
            intentLabelMap={intentLabelMap}
            onReload={() => void suggestions.refreshSuggestions('manual')}
            onSuggestionClick={chat.handleSuggestionClick}
          />
          <ChatPanel
            chatMessages={chat.chatMessages}
            chatInput={chat.chatInput}
            isSendingChat={chat.isSendingChat}
            chatEndRef={chat.chatEndRef}
            onInputChange={chat.setChatInput}
            onSubmit={chat.handleChatSubmit}
          />
        </section>
      ) : null}
    </main>
  )
}

export default App
