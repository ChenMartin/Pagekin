import type { GenerationRecoveryContext } from './generation-owner-contract'

/**
 * 运行侧页、蓝图页横幅与架构页的大纲提示共用的一条判定：这份规划恢复稿还要不要给作者。
 * 续写已完成、本批已原样在正式大纲里、还缺的章后来都有了正式内容、作者放弃了，都不再给。
 */
export function planningRecoverable(context: GenerationRecoveryContext): boolean {
  if (!context.plotOutlineRecovery && !context.blueprintRecovery) return false
  if (context.planningDraft && context.planningDraft.standing !== 'open') return false
  return context.planningContinuation?.state !== 'complete' && !context.plotOutlineRecovery?.inFormalOutline
}
