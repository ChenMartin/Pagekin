function lines(text) {
  const result = []
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/g)) {
    if (match[0]) result.push({ key: match[0].replace(/\r\n?$/, '\n'), offset: match.index })
  }
  return result
}

function uniqueLines(rows) {
  const positions = new Map()
  rows.forEach(({ key }, i) => positions.set(key, positions.has(key) ? -1 : i))
  return positions
}

function anchors(left, right) {
  const original = uniqueLines(left)
  const revised = uniqueLines(right)
  const tails = []
  // Find the longest in-order chain of lines that occur once in each version.
  for (const [key, from] of original) {
    const to = revised.get(key)
    if (from < 0 || to === undefined || to < 0) continue
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (tails[mid].to < to) low = mid + 1
      else high = mid
    }
    tails[low] = { from, to, previous: tails[low - 1] }
  }
  const result = []
  for (let entry = tails.at(-1); entry; entry = entry.previous) result.push(entry)
  return result.reverse()
}

export function revisionChanges(original, revised) {
  const left = lines(original)
  const right = lines(revised)
  const unchanged = anchors(left, right)
  unchanged.push({ from: left.length, to: right.length })
  const changes = []
  const add = (from, end, to, limit) => changes.push({
    start: left[from]?.offset ?? original.length,
    end: left[end]?.offset ?? original.length,
    line: from + 1,
    after: revised.slice(right[to]?.offset ?? revised.length, right[limit]?.offset ?? revised.length),
  })
  let from = 0
  let to = 0
  for (const anchor of unchanged) {
    let end = anchor.from
    let limit = anchor.to
    while (from < end && to < limit && left[from].key === right[to].key) { from++; to++ }
    while (from < end && to < limit && left[end - 1].key === right[limit - 1].key) { end--; limit-- }
    if (end - from === limit - to) {
      for (let i = from, j = to; i < end; i++, j++) {
        if (left[i].key !== right[j].key) add(i, i + 1, j, j + 1)
      }
    } else add(from, end, to, limit)
    from = anchor.from + 1
    to = anchor.to + 1
  }
  return changes
}

export function mergeRevision(original, changes, picks, edits = new Map()) {
  const pieces = []
  let cursor = 0
  changes.forEach(({ start, end, after }, i) => {
    if (!picks.has(i)) return
    pieces.push(original.slice(cursor, start), edits.get(i) ?? after)
    cursor = end
  })
  pieces.push(original.slice(cursor))
  return pieces.join('')
}
