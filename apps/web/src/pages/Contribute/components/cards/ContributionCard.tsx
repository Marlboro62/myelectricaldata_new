import { ExternalLink, Copy, MessageCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { type Contribution } from '@/api/energy'
import ChatWhatsApp, { type ChatMessage } from '@/components/ChatWhatsApp'
import { getOfferTypeLabel, formatPrice, isProviderOnlyContribution } from '../../utils'

interface ContributionCardProps {
  contribution: Contribution
  // États pour les messages
  replyMessages: Record<string, string>
  sendingReply: string | null
  expandedMessages: Record<string, boolean>
  setReplyMessages: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setExpandedMessages: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  // Fonctions
  onEdit: (contribution: Contribution) => void
  onSendReply: (contributionId: string) => void
}

export default function ContributionCard({
  contribution,
  replyMessages,
  sendingReply,
  expandedMessages,
  setReplyMessages,
  setExpandedMessages,
  onEdit,
  onSendReply,
}: ContributionCardProps) {
  // Check if last message is from admin (unread)
  const lastMessage = contribution.messages?.[contribution.messages.length - 1]
  const hasUnreadMessage = lastMessage?.is_from_admin ?? false
  // Keep expanded if user is writing or sending a message
  const isWritingMessage = !!replyMessages[contribution.id]?.trim()
  const isSendingMessage = sendingReply === contribution.id
  const isMessagesExpanded = expandedMessages[contribution.id] ?? hasUnreadMessage ?? isWritingMessage ?? isSendingMessage
  // Show messages section for pending contributions (can send messages) or if there are existing messages
  const showMessagesSection = contribution.status === 'pending' || (contribution.messages && contribution.messages.length > 0)
  const messageCount = contribution.messages?.length ?? 0

  return (
    <div
      className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden"
    >
      {/* Compact Header with all key info */}
      <div className="p-3 bg-gray-50 dark:bg-gray-900/50">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-base truncate">{contribution.offer_name}</h3>
              <span className="text-xs px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded shrink-0">
                {isProviderOnlyContribution(contribution) ? 'Nouveau fournisseur' : getOfferTypeLabel(contribution.offer_type)}
              </span>
              {contribution.power_kva && (
                <span className="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded shrink-0">
                  {contribution.power_kva} kVA
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 flex-wrap">
              <span>
                {contribution.contribution_type === 'NEW_PROVIDER'
                  ? contribution.provider_name
                  : contribution.existing_provider_name || 'Fournisseur existant'}
              </span>
              <span>•</span>
              <span>{new Date(contribution.created_at).toLocaleDateString('fr-FR')}</span>
              {contribution.description && (
                <>
                  <span>•</span>
                  <span className="truncate max-w-[200px]">{contribution.description}</span>
                </>
              )}
            </div>
          </div>
          {/* Documentation links */}
          <div className="flex gap-1 shrink-0">
            {contribution.price_sheet_url && (
              <a
                href={contribution.price_sheet_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded"
                title="Fiche des prix"
              >
                <ExternalLink size={14} />
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Compact Pricing - inline */}
      {contribution.pricing_data && (
        <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700 text-xs">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {contribution.pricing_data.subscription_price !== undefined && (
              <span><span className="text-gray-500">Abo:</span> <span className="font-medium">{contribution.pricing_data.subscription_price}€</span></span>
            )}
            {contribution.pricing_data.base_price !== undefined && (
              <span><span className="text-gray-500">Base:</span> <span className="font-medium">{formatPrice(contribution.pricing_data.base_price)}</span></span>
            )}
            {contribution.pricing_data.hc_price !== undefined && (
              <span><span className="text-gray-500">HC:</span> <span className="font-medium">{formatPrice(contribution.pricing_data.hc_price)}</span></span>
            )}
            {contribution.pricing_data.hp_price !== undefined && (
              <span><span className="text-gray-500">HP:</span> <span className="font-medium">{formatPrice(contribution.pricing_data.hp_price)}</span></span>
            )}
            {/* Tempo prices - compact */}
            {contribution.pricing_data.tempo_blue_hc !== undefined && (
              <>
                <span className="text-blue-600 dark:text-blue-400">
                  <span className="font-medium">Bleu</span> {formatPrice(contribution.pricing_data.tempo_blue_hc)}/{formatPrice(contribution.pricing_data.tempo_blue_hp)}
                </span>
                <span>
                  <span className="font-medium">Blanc</span> {formatPrice(contribution.pricing_data.tempo_white_hc)}/{formatPrice(contribution.pricing_data.tempo_white_hp)}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  <span className="font-medium">Rouge</span> {formatPrice(contribution.pricing_data.tempo_red_hc)}/{formatPrice(contribution.pricing_data.tempo_red_hp)}
                </span>
              </>
            )}
            {/* EJP prices */}
            {contribution.pricing_data.ejp_normal !== undefined && (
              <>
                <span><span className="text-gray-500">Normal:</span> <span className="font-medium">{formatPrice(contribution.pricing_data.ejp_normal)}</span></span>
                <span className="text-orange-600 dark:text-orange-400"><span className="font-medium">Pointe:</span> {formatPrice(contribution.pricing_data.ejp_peak)}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Edit button - compact, for rejected and pending contributions */}
      {(contribution.status === 'rejected' || contribution.status === 'pending') && (
        <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700">
          <button
            onClick={() => onEdit(contribution)}
            className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              contribution.status === 'rejected'
                ? 'bg-orange-100 hover:bg-orange-200 text-orange-700 dark:bg-orange-900/30 dark:hover:bg-orange-900/50 dark:text-orange-300'
                : 'bg-blue-100 hover:bg-blue-200 text-blue-700 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 dark:text-blue-300'
            }`}
          >
            <Copy size={12} />
            Modifier
          </button>
        </div>
      )}

      {/* Messages / Conversation - WhatsApp Style */}
      {showMessagesSection && (
        <div className="border-t border-gray-100 dark:border-gray-700">
          <button
            onClick={() => {
              if (isWritingMessage || isSendingMessage) return
              setExpandedMessages(prev => ({ ...prev, [contribution.id]: !isMessagesExpanded }))
            }}
            className={`w-full flex items-center justify-between px-3 py-2 transition-colors ${
              isWritingMessage || isSendingMessage
                ? 'cursor-default'
                : 'hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <MessageCircle className={hasUnreadMessage ? "text-red-500" : "text-gray-400"} size={14} />
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Échanges {messageCount > 0 && `(${messageCount})`}
              </span>
              {hasUnreadMessage && (
                <span className="text-[10px] px-1.5 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full animate-pulse">
                  Nouveau
                </span>
              )}
            </div>
            {!(isWritingMessage || isSendingMessage) && (
              isMessagesExpanded ? (
                <ChevronDown className="text-gray-400" size={14} />
              ) : (
                <ChevronRight className="text-gray-400" size={14} />
              )
            )}
          </button>
          {(isMessagesExpanded || isWritingMessage || isSendingMessage) && (
            <div className="px-2 pb-2">
              <ChatWhatsApp
                messages={(contribution.messages || []) as ChatMessage[]}
                isAdminView={false}
                inputValue={replyMessages[contribution.id] || ''}
                onInputChange={(value) => setReplyMessages(prev => ({ ...prev, [contribution.id]: value }))}
                onSend={() => onSendReply(contribution.id)}
                isSending={sendingReply === contribution.id}
                showInput={contribution.status === 'pending'}
                minHeight="120px"
                maxHeight="250px"
              />
            </div>
          )}
        </div>
      )}

      {/* Review comment for rejected - compact */}
      {contribution.status === 'rejected' && contribution.review_comment && (
        <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700 bg-red-50 dark:bg-red-900/20">
          <p className="text-xs text-red-600 dark:text-red-400">
            <span className="font-medium">Rejet :</span> {contribution.review_comment}
          </p>
        </div>
      )}
    </div>
  )
}
