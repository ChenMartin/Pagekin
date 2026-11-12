import { english } from './locale-en.mjs'

const preference = 'pagekin-interface-language'
let selected = 'zh-CN'
try { if (localStorage.getItem(preference) === 'en-US') selected = 'en-US' }
catch { /* Browser storage can be unavailable. */ }
export const locale = selected

export function ui(message, ...args) {
  const text = locale === 'en-US' && Object.hasOwn(english, message) ? english[message] : message
  return args.length ? text.replace(/\$(\d+)/gu, (token, position) => position <= args.length ? String(args[position - 1]) : token) : text
}

export function rememberLocale(value) {
  if (!['zh-CN', 'en-US'].includes(value)) throw new Error('Invalid interface language')
  localStorage.setItem(preference, value)
}

export function translateStatic(document) {
  document.documentElement.lang = locale
  if (locale !== 'en-US') return
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const original = node.nodeValue.trim()
    if (original && Object.hasOwn(english, original)) node.nodeValue = node.nodeValue.replace(original, () => ui(original))
  }
  for (const element of document.querySelectorAll('[aria-label], [placeholder]')) {
    for (const attr of ['aria-label', 'placeholder']) {
      if (element.hasAttribute(attr)) element.setAttribute(attr, ui(element.getAttribute(attr)))
    }
  }
}
