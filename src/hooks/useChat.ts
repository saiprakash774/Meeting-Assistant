import { useEffect, useRef, useState } from 'react'
import type { AppSettings, ChatMessage, ChatRole, Suggestion } from '../types'
import { createAssistantChatReply, createDetailedSuggestionAnswer } from '../lib/groq'
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

  const addChatMessage = (
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

  const handleSuggestionClick = async (suggestion: Suggestion) => {
    if (!settingsRef.current.apiKey) {
      onError('Add your Groq API key in Settings first.')
      return
    }
    const contextTag = intentLabelMap[suggestion.intent] || 'Suggestion'
    addChatMessage('user', suggestion.preview, undefined, contextTag)
    setIsSendingChat(true)
    try {
      const t0 = Date.now()
      const context =
        buildSessionHeader(sessionStartRef.current) +
        transcriptTextRef.current.slice(-settingsRef.current.detailContextChars)
      const reply = await createDetailedSuggestionAnswer(
        settingsRef.current.apiKey,
        settingsRef.current.detailAnswerPrompt,
        context,
        suggestion,
        settingsRef.current.meetingContext,
      )
      addChatMessage('assistant', sanitizeAssistantMarkdown(reply), Date.now() - t0, contextTag)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to expand suggestion.'
      if (isDailyLimitError(msg)) {
        addChatMessage(
          'assistant',
          `Groq daily quota reached — unable to expand this suggestion.${extractWaitTime(msg)} The quota resets automatically; try again later.`,
        )
      } else {
        onError(msg)
      }
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
    addChatMessage('user', question)
    setIsSendingChat(true)
    try {
      const t0 = Date.now()
      const context =
        buildSessionHeader(sessionStartRef.current) +
        transcriptTextRef.current.slice(-settingsRef.current.chatContextChars)
      // Build history including the just-typed message so the model sees it as context.
      const history = [
        ...chatMessages,
        { id: makeId(), role: 'user' as const, content: question, createdAt: nowIso() },
      ]
      const reply = await createAssistantChatReply(
        settingsRef.current.apiKey,
        settingsRef.current.chatPrompt,
        context,
        history,
        settingsRef.current.meetingContext,
      )
      addChatMessage('assistant', sanitizeAssistantMarkdown(reply), Date.now() - t0)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send chat message.'
      if (isDailyLimitError(msg)) {
        addChatMessage(
          'assistant',
          `Groq daily quota reached — unable to answer right now.${extractWaitTime(msg)} The quota resets automatically; try again later.`,
        )
      } else {
        onError(msg)
      }
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
