export function continuationPrefix(text) {
  let boundary = 0
  for (const match of text.matchAll(/\r\n|[\r\n]|[。！？!?](?:[”’」』）》】"'])*|\.(?:[”’"'])*(?=\s|$)/gu)) {
    boundary = match.index + match[0].length
  }
  return text.slice(0, boundary).trimEnd()
}

export function continuationAddition(prefix, output) {
  const trimBlankLines = text => text.replace(/^(?:[ \t]*(?:\r\n|[\r\n]))+/, '')
  const text = trimBlankLines(output)
  const echo = trimBlankLines(prefix)
  if (text.startsWith(echo)) return trimBlankLines(text.slice(echo.length))

  // Match the longest exact overlap between the saved tail and the new text.
  const tail = prefix.slice(-4096)
  const head = text.slice(0, tail.length)
  if (head.length < 8) return text
  const lengths = new Uint16Array(head.length)
  for (let i = 1, length = 0; i < head.length; i++) {
    while (length && head[i] !== head[length]) length = lengths[length - 1]
    if (head[i] === head[length]) length++
    lengths[i] = length
  }
  let overlap = 0
  for (let i = 0; i < tail.length; i++) {
    while (overlap && (overlap === head.length || tail[i] !== head[overlap])) overlap = lengths[overlap - 1]
    if (tail[i] === head[overlap]) overlap++
  }
  return overlap >= 8 ? trimBlankLines(text.slice(overlap)) : text
}
