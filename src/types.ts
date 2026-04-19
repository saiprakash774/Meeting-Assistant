export type TranscriptEntry = {
  id: string
  text: string
  createdAt: string
}

export type Suggestion = {
  id: string
  title: string
  preview: string
  intent: string
}

export type SuggestionBatch = {
  id: string
  createdAt: string
  latencyMs: number
  suggestions: Suggestion[]
}

export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  createdAt: string
  latencyMs?: number
  contextTag?: string
}

export type Vibe = 'positive' | 'neutral' | 'critical'

export type AppSettings = {
  apiKey: string
  meetingContext: string
  suggestionIntervalMs: number
  suggestionContextChars: number
  detailContextChars: number
  chatContextChars: number
  noiseGateEnabled: boolean
  noiseGateMinKb: number
  liveSuggestionsPrompt: string
  detailAnswerPrompt: string
  chatPrompt: string
}

// 'manual' — user clicked Reload; cooldown + change-detection apply
// 'auto'   — timer fired; no cooldown, no change-detection
// 'stop'   — mic stopped; no cooldown, generates final batch
export type RefreshTrigger = 'manual' | 'auto' | 'stop'
