import ReactMarkdown from 'react-markdown'
import type { ChatMessage } from '../types'

type Props = {
  chatMessages: ChatMessage[]
  chatInput: string
  isSendingChat: boolean
  chatEndRef: React.RefObject<HTMLDivElement | null>
  onInputChange: (val: string) => void
  onSubmit: (e: React.SyntheticEvent<HTMLFormElement>) => void
}

export default function ChatPanel({
  chatMessages,
  chatInput,
  isSendingChat,
  chatEndRef,
  onInputChange,
  onSubmit,
}: Props) {
  return (
    <div className="column">
      <div className="panel-title-row">
        <h2>3. CHAT (DETAILED ANSWERS)</h2>
        <span className="status-chip">session only</span>
      </div>
      <div className="panel col-panel">
        <div className="col-scroll chat-messages">
          {chatMessages.length === 0 ? (
            <p className="muted">Click a suggestion or ask a question below.</p>
          ) : null}
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
          <div ref={chatEndRef} />
        </div>
        <form onSubmit={onSubmit} className="chat-form">
          <input
            value={chatInput}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder="Ask anything about this meeting..."
          />
          <button type="submit" disabled={isSendingChat}>
            {isSendingChat ? 'Sending...' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  )
}
