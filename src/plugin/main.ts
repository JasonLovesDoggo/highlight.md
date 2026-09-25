import { Editor, Notice, Plugin } from "obsidian"
import { highlightMarkup, isHighlightAround } from "../markup.js"

export default class AiHighlightPlugin extends Plugin {
  onload(): void {
    this.addCommand({
      id: "highlight-selection",
      name: "Highlight selected text",
      editorCallback: (editor: Editor) => {
        const selection = editor.getSelection()
        if (selection.length === 0) {
          new Notice("Select text first, then run Highlight selected text.")
          return
        }

        if (selection.includes("\n") || selection.includes("\r")) {
          new Notice("Highlight one line at a time.")
          return
        }

        const from = editor.getCursor("from")
        const to = editor.getCursor("to")
        const lineBefore = editor.getLine(from.line)
        const lineAfter = editor.getLine(to.line)
        const beforeEquals = from.ch >= 2 ? lineBefore.slice(from.ch - 2, from.ch) : ""
        const beforeMark = from.ch >= 6 ? lineBefore.slice(from.ch - 6, from.ch) : ""
        const afterEquals = to.ch + 2 <= lineAfter.length ? lineAfter.slice(to.ch, to.ch + 2) : ""
        const afterMark = to.ch + 7 <= lineAfter.length ? lineAfter.slice(to.ch, to.ch + 7) : ""

        if (isHighlightAround(beforeEquals, afterEquals) || isHighlightAround(beforeMark, afterMark)) {
          new Notice("That text is already highlighted.")
          return
        }

        editor.replaceSelection(highlightMarkup(selection))
      },
    })
  }
}
