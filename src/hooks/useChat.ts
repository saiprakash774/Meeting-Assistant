import { useEffect, useRef, useState } from 'react'
import type { AppSettings, ChatMessage, ChatRole, Suggestion } from '../types'
import { streamAssistantChatReply, streamDetailedSuggestionAnswer } from '../lib/groq'
import { buildSessionHeader, isDailyLimitError, extractWaitTime, makeId, nowIso, sanitizeAssistantMarkdown } from '../lib/utils'
import { intentLabelMap } from '../constants'

type Params = {
  settingsRef: React.MutableRefObject<AppSettings>
  transcriptTextRef: React.MutableRefObject<string>
  sessionStartRef: React.MutableRefObject<Date | null>
  onError: (msg: string) => void
}

export function useChat({ settingsRef, transcriptTextRef, sessionStartRef, onError }: Params) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [isSendingChat, setIsSendingChat] = useState(false)
  const [chatInput, setChatInput] = useState('')

  const chatEndRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chatMessages])

  const addMessage = (
    role: ChatRole,
    content: string,
    latencyMs?: number,
    contextTag?: string,
  ) => {
    setChatMessages((prev) => [
      ...prev,
      { id: makeId(), role, content, createdAt: nowIso(), latencyMs, contextTag },
    ])
  }

  // Streams tokens from an async generator into a placeholder assistant message,
  // then finalises with sanitized content and latency. Handles daily-limit and
  // general errors without leaving a broken empty message in the thread.
  const streamResponse = async (
    generator: AsyncGenerator<string, void, unknown>,
    contextTag?: string,
  ): Promise<void> => {
    const assistantId = makeId()
    const t0 = Date.now()
    setChatMessages((prev) => [
      ...prev,
      { id: assistantId, role: 'assistant' as const, content: '', createdAt: nowIso(), contextTag },
    ])
    let accumulated = ''
    try {
      for await (const token of generator) {
        accumulated += token
        setChatMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m)),
        )
      }
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: sanitizeAssistantMarkdown(accumulated) || 'No response returned.', latencyMs: Date.now() - t0 }
            : m,
        ),
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error generating response.'
      if (isDailyLimitError(msg)) {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: `Groq daily quota reached.${extractWaitTime(msg)} The quota resets automatically; try again later.`,
                }
              : m,
          ),
        )
      } else {
        setChatMessages((prev) => prev.filter((m) => m.id !== assistantId))
        onError(msg)
      }
    }
  }

  const handleSuggestionClick = async (suggestion: Suggestion) => {
    if (!settingsRef.current.apiKey) {
      onError('Add your Groq API key in Settings first.')
      return
    }
    const contextTag = intentLabelMap[suggestion.intent] || 'Suggestion'
    addMessage('user', suggestion.preview, undefined, contextTag)
    setIsSendingChat(true)
    try {
      const context =
        buildSessionHeader(sessionStartRef.current) +
        transcriptTextRef.current.slice(-settingsRef.current.detailContextChars)
      await streamResponse(
        streamDetailedSuggestionAnswer(
          settingsRef.current.apiKey,
          settingsRef.current.detailAnswerPrompt,
          context,
          suggestion,
          settingsRef.current.meetingContext,
        ),
        contextTag,
      )
    } finally {
      setIsSendingChat(false)
    }
  }

  const handleChatSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!settingsRef.current.apiKey) {
      onError('Add your Groq API key in Settings first.')
      return
    }
    const question = chatInput.trim()
    if (!question) return
    setChatInput('')
    addMessage('user', question)
    setIsSendingChat(true)
    try {
      const context =
        buildSessionHeader(sessionStartRef.current) +
        transcriptTextRef.current.slice(-settingsRef.current.chatContextChars)
      const history = [
        ...chatMessages,
        { id: makeId(), role: 'user' as const, content: question, createdAt: nowIso() },
      ]
      await streamResponse(
        streamAssistantChatReply(
          settingsRef.current.apiKey,
          settingsRef.current.chatPrompt,
          context,
          history,
          settingsRef.current.meetingContext,
        ),
      )
    } finally {
      setIsSendingChat(false)
    }
  }

  return {
    chatMessages,
    isSendingChat,
    chatInput,
    setChatInput,
    chatEndRef,
    handleSuggestionClick,
    handleChatSubmit,
  }
}
