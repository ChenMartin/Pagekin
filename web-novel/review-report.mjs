const limits = { title: 80, quote: 180, reason: 360, suggestion: 500 }
const lineEndings = text => text.replace(/\r\n?/g, '\n')

export function reviewReport(output, snapshot) {
  const text = output.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text)
  let report
  try { report = JSON.parse(fenced?.[1] ?? text) }
  catch { return null }
  if (!Array.isArray(report?.issues) || report.issues.length > 12) return null

  const body = snapshot === undefined ? undefined : lineEndings(snapshot)
  const issues = []
  for (const issue of report.issues) {
    if (!issue || !['major', 'minor'].includes(issue.severity)) return null
    for (const [key, max] of Object.entries(limits)) {
      if (typeof issue[key] !== 'string' || !issue[key].trim() || issue[key].length > max) return null
    }
    const quote = lineEndings(issue.quote)
    const start = body?.indexOf(quote)
    let evidence = 'unavailable'
    if (start !== undefined) {
      if (start < 0) evidence = 'missing'
      else evidence = body.indexOf(quote, start + 1) >= 0 ? 'ambiguous' : 'verified'
    }
    issues.push({ title: issue.title, severity: issue.severity, quote, reason: issue.reason, suggestion: issue.suggestion, evidence })
  }
  return { issues }
}
