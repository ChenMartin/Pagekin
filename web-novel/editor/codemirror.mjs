import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'

export function createEditor(host, { value, maxLength, nonce, onEdit, onSelection, onComposition, onLimit, label, hint }) {
  const access = new Compartment()
  const editable = new Compartment()
  const attributes = new Compartment()
  let locked = false
  let replacing = false

  function contentAttributes(readOnly) {
    return EditorView.contentAttributes.of({
      'aria-label': label,
      'aria-readonly': String(readOnly),
      spellcheck: 'false',
      tabindex: '0',
    })
  }

  function state(doc) {
    return EditorState.create({
      doc,
      extensions: [
        EditorView.cspNonce.of(nonce),
        EditorView.lineWrapping,
        markdown({ addKeymap: false }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        placeholder(hint),
        access.of(EditorState.readOnly.of(locked)),
        editable.of(EditorView.editable.of(!locked)),
        attributes.of(contentAttributes(locked)),
        EditorState.changeFilter.of(transaction => {
          if (transaction.newDoc.length <= maxLength || transaction.newDoc.length <= transaction.startState.doc.length) return true
          queueMicrotask(onLimit)
          return false
        }),
        EditorView.domEventHandlers({
          compositionstart() { onComposition(true) },
          compositionend() { onComposition(false) },
          blur() { onComposition(false) },
          beforeinput(event) { if (locked) event.preventDefault() },
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !replacing) onEdit()
          if (update.selectionSet && !replacing) onSelection()
        }),
      ],
    })
  }

  const view = new EditorView({ parent: host, state: state(value) })
  return {
    maxLength,
    get value() { return view.state.doc.toString() },
    set value(text) {
      replacing = true
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }) }
      finally { replacing = false }
    },
    set readOnly(value) {
      if (value === locked) return
      locked = value
      view.dispatch({ effects: [
        access.reconfigure(EditorState.readOnly.of(value)), editable.reconfigure(EditorView.editable.of(!value)),
        attributes.reconfigure(contentAttributes(value)),
      ] })
    },
    get selectionStart() { return view.state.selection.main.from },
    get selectionEnd() { return view.state.selection.main.to },
    setSelectionRange(start, end) {
      view.dispatch({ selection: { anchor: start, head: end } })
    },
    focus() { view.focus() },
    reveal(offset) { view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: 'center' }) }) },
    reset(text) {
      view.setState(state(text))
      view.scrollDOM.scrollTop = 0
    },
  }
}
