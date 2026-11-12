export const approaches = { plan: '规划优先', explore: '探索优先', mixed: '混合推进' }

export const projectFields = [
  ['hook', '故事吸引点与阅读体验', 320], ['decisions', '已决定的方向与理由', 600], ['boundaries', '写作边界与不改动项', 400],
  ['unresolved', '候选方向与待调研', 800], ['voice', '叙述声音与人物表达', 450], ['sample', '作者认可的片段', 600],
  ['next', '下一步与作者备注', 500],
]

export const chapterFields = [
  ['purpose', '本章目标与承接', 360], ['viewpoint', '视角人物', 120], ['time', '故事时间与起始状态', 220],
  ['known', '本场人物已经知道的事', 360], ['withheld', '本场暂不揭示的信息', 360],
]

export const methodCards = {
  opening: { title: '开篇与阅读期待', guide: '通过人物的处境和选择建立读者期待。只安排本章能兑现的铺垫。' },
  protagonist: { title: '人物目标与代价', guide: '用行动表现人物当下所求、面对的阻力和选择的代价。允许人物保持原有立场。' },
  stakes: { title: '冲突升级与转折', guide: '核对行动如何改变处境或代价。转折应来自人物选择和已经建立的条件。' },
  relationship: { title: '关系线与人物声音', guide: '用角色在不同关系中的诉求、措辞和反应呈现差异，承接已有关系变化。' },
  mystery: { title: '谜题与信息释放', guide: '区分作者真相、人物知情和读者线索。核对信息经谁传递，在什么时点可得。' },
  payoff: { title: '承诺与回收', guide: '核对前文的重要承诺与后果。保留作者有意开放的问题，不为凑回收改变结局。' },
}
