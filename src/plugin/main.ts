import { StateEffect } from "@codemirror/state"
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view"
import { App, Editor, editorInfoField, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian"
import { Annotation, createAnnotation, HighlightData, locateAnnotation, parseHighlightData } from "../annotations.js"
import { highlightMarkup, isHighlightAround } from "../markup.js"

const refreshAnnotations = StateEffect.define<null>()

export default class AiHighlightPlugin extends Plugin {
  private data: HighlightData = { mode: "markdown", annotations: [] }
  private readonly editors = new Set<EditorView>()
  private pendingSave: Promise<void> = Promise.resolve()

  async onload(): Promise<void> {
    this.data = parseHighlightData(await this.loadData())
    this.addSettingTab(new HighlightSettingsTab(this.app, this))
    this.registerEditorExtension(this.annotationExtension())
    this.addCommand({
      id: "highlight-selection",
      name: "Highlight selected text",
      editorCallback: (editor, context) => {
        void this.highlightSelection(editor, context.file?.path)
      },
    })
    this.addCommand({
      id: "comment-selection",
      name: "Comment on selected text",
      editorCallback: (editor, context) => {
        const path = context.file?.path
        const quote = editor.getSelection()
        if (!path || !quote) {
          new Notice("Select text in a note first.")
          return
        }
        const offset = editor.posToOffset(editor.getCursor("from"))
        new CommentModal(this.app, (comment) => {
          if (editor.getValue().slice(offset, offset + quote.length) !== quote) {
            new Notice("The selected text changed. Select it again before commenting.")
            return
          }
          void this.addAnnotation(path, editor.getValue(), offset, quote, comment)
        }).open()
      },
    })
    this.addCommand({
      id: "show-annotations",
      name: "Show annotations in current note",
      callback: () => {
        const path = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path
        if (!path) {
          new Notice("Open a Markdown note first.")
          return
        }
        new AnnotationsModal(this.app, this.data.annotations.filter((annotation) => annotation.path === path), (id) => {
          void this.removeAnnotation(id)
        }).open()
      },
    })
  }

  async onExternalSettingsChange(): Promise<void> {
    await this.pendingSave
    this.data = parseHighlightData(await this.loadData())
    this.refreshEditors()
  }

  get mode(): HighlightData["mode"] {
    return this.data.mode
  }

  async setMode(mode: HighlightData["mode"]): Promise<void> {
    await this.updateData((data) => ({ ...data, mode }))
    new Notice(`Highlight mode: ${mode === "overlay" ? "Annotations" : "Markdown"}`)
  }

  private async highlightSelection(editor: Editor, path: string | undefined): Promise<void> {
    const quote = editor.getSelection()
    if (!quote) {
      new Notice("Select text first, then run Highlight selected text.")
      return
    }
    if (this.data.mode === "overlay") {
      if (!path) {
        new Notice("Open a Markdown note before highlighting.")
        return
      }
      await this.addAnnotation(path, editor.getValue(), editor.posToOffset(editor.getCursor("from")), quote)
      return
    }
    if (quote.includes("\n") || quote.includes("\r")) {
      new Notice("Markdown highlights must stay on one line. Annotation mode supports multiple lines.")
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
    editor.replaceSelection(highlightMarkup(quote))
  }

  private async addAnnotation(path: string, contents: string, offset: number, quote: string, comment = ""): Promise<void> {
    try {
      const annotation = createAnnotation(path, contents, offset, quote, comment)
      if (locateAnnotation(contents, annotation) !== offset) {
        throw new Error("This selection cannot be anchored uniquely. Select a longer passage.")
      }
      await this.updateData((data) => {
        const exists = data.annotations.some((current) => current.path === path && current.quote === quote && locateAnnotation(contents, current) === offset)
        if (exists) throw new Error("That selection already has an annotation.")
        return { ...data, annotations: [...data.annotations, annotation] }
      })
      new Notice(comment ? "Comment added." : "Annotation highlight added.")
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error))
    }
  }

  private async removeAnnotation(id: string): Promise<void> {
    await this.updateData((data) => ({
      ...data,
      annotations: data.annotations.filter((annotation) => annotation.id !== id),
    }))
    new Notice("Annotation removed.")
  }

  private updateData(change: (data: HighlightData) => HighlightData): Promise<void> {
    const result = this.pendingSave.then(async () => {
      const updated = change(parseHighlightData(await this.loadData()))
      await this.saveData(updated)
      this.data = updated
      this.refreshEditors()
    })
    this.pendingSave = result.catch(() => undefined)
    return result
  }

  private refreshEditors(): void {
    for (const editor of this.editors) editor.dispatch({ effects: refreshAnnotations.of(null) })
  }

  private annotationExtension() {
    const owner = this
    return ViewPlugin.fromClass(class {
      decorations: DecorationSet
      constructor(private readonly view: EditorView) {
        owner.editors.add(view)
        this.decorations = this.build()
      }
      update(update: ViewUpdate): void {
        const oldPath = update.startState.field(editorInfoField).file?.path
        const newPath = update.state.field(editorInfoField).file?.path
        if (update.docChanged || oldPath !== newPath || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshAnnotations)))) {
          this.decorations = this.build()
        }
      }
      destroy(): void {
        owner.editors.delete(this.view)
      }
      private build(): DecorationSet {
        const path = this.view.state.field(editorInfoField).file?.path
        if (!path) return Decoration.none
        const contents = this.view.state.doc.toString()
        const marks = owner.data.annotations
          .filter((annotation) => annotation.path === path)
          .map((annotation) => owner.markFor(contents, annotation))
          .filter((mark) => mark !== null)
          .sort((left, right) => left.from - right.from)
        return Decoration.set(marks)
      }
    }, { decorations: (plugin) => plugin.decorations })
  }

  private markFor(contents: string, annotation: Annotation) {
    const from = locateAnnotation(contents, annotation)
    if (from === null) return null
    return Decoration.mark({
      class: "ai-highlight-annotation",
      attributes: { title: annotation.comment || "Annotation highlight" },
    }).range(from, from + annotation.quote.length)
  }
}

class HighlightSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly owner: AiHighlightPlugin) {
    super(app, owner)
  }
  display(): void {
    this.containerEl.empty()
    new Setting(this.containerEl)
      .setName("Highlight mode")
      .setDesc("Markdown changes the note. Annotations are stored in the plugin data and drawn over the editor.")
      .addDropdown((dropdown) => dropdown
        .addOption("markdown", "Markdown markup")
        .addOption("overlay", "Annotations (no note changes)")
        .setValue(this.owner.mode)
        .onChange((value) => {
          if (value === "markdown" || value === "overlay") void this.owner.setMode(value)
        }))
  }
}

class CommentModal extends Modal {
  constructor(app: App, private readonly submit: (comment: string) => void) {
    super(app)
  }
  onOpen(): void {
    this.setTitle("Comment on selection")
    let comment = ""
    new Setting(this.contentEl).addTextArea((input) => input
      .setPlaceholder("Write a comment")
      .onChange((value) => { comment = value }))
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText("Add comment")
      .setCta()
      .onClick(() => {
        if (!comment.trim()) return
        this.close()
        this.submit(comment.trim())
      }))
  }
  onClose(): void {
    this.contentEl.empty()
  }
}

class AnnotationsModal extends Modal {
  constructor(
    app: App,
    private readonly annotations: Annotation[],
    private readonly remove: (id: string) => void,
  ) {
    super(app)
  }
  onOpen(): void {
    this.setTitle("Annotations in this note")
    if (this.annotations.length === 0) {
      this.contentEl.createEl("p", { text: "No annotations in this note." })
      return
    }
    for (const annotation of this.annotations) {
      new Setting(this.contentEl)
        .setName(annotation.quote.slice(0, 100))
        .setDesc(annotation.comment || "Highlight")
        .addButton((button) => button
          .setButtonText("Remove")
          .onClick(() => {
            this.remove(annotation.id)
            this.close()
          }))
    }
  }
  onClose(): void {
    this.contentEl.empty()
  }
}
