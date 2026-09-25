import { StateEffect } from "@codemirror/state"
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view"
import { App, Editor, editorInfoField, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian"
import { Annotation, createAnnotation, HighlightData, locateAnnotation, parseHighlightData } from "../annotations.js"
import { highlightMarkup, isHighlightAround } from "../markup.js"

const refreshAnnotations = StateEffect.define<null>()

export default class AiHighlightPlugin extends Plugin {
  private data: HighlightData = { mode: "markdown", visible: true, annotations: [] }
  private readonly editors = new Set<EditorView>()
  private pendingSave: Promise<void> = Promise.resolve()
  private popover: HTMLElement | null = null
  private popoverAnnotationId: string | null = null
  private popoverHideTimer: number | null = null

  async onload(): Promise<void> {
    this.data = parseHighlightData(await this.loadData())
    this.registerInterval(window.setInterval(() => {
      void this.reloadExternalData().catch((error: unknown) => {
        console.error("AI Highlight could not reload external annotations.", error)
      })
    }, 2000))
    this.addSettingTab(new HighlightSettingsTab(this.app, this))
    this.registerEditorExtension(this.annotationExtension())
    this.registerDomEvent(document, "mouseover", (event) => this.onMouseOver(event))
    this.registerDomEvent(document, "mouseout", (event) => this.onMouseOut(event))
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape") this.hidePopover()
    })
    this.addCommand({
      id: "highlight-selection",
      name: "Highlight selected text",
      editorCallback: (editor, context) => {
        void this.highlightSelection(editor, context.file?.path)
      },
    })
    this.addCommand({
      id: "comment-selection",
      name: "Add concept or comment to selected text",
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
      id: "suggest-selection",
      name: "Suggest edit for selected text",
      editorCallback: (editor, context) => {
        const path = context.file?.path
        const quote = editor.getSelection()
        if (!path || !quote) {
          new Notice("Select text in a note first.")
          return
        }
        const offset = editor.posToOffset(editor.getCursor("from"))
        new SuggestionModal(this.app, (suggestion, comment) => {
          if (editor.getValue().slice(offset, offset + quote.length) !== quote) {
            new Notice("The selected text changed. Select it again before suggesting an edit.")
            return
          }
          void this.addAnnotation(path, editor.getValue(), offset, quote, comment, suggestion)
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
        new AnnotationsModal(
          this.app,
          this.data.annotations.filter((annotation) => annotation.path === path),
          (id) => { void this.removeAnnotation(id) },
          (id) => { void this.applySuggestion(id) },
        ).open()
      },
    })
    this.addCommand({
      id: "hide-all-annotations",
      name: "Hide all annotations",
      callback: () => { void this.setVisible(false) },
    })
    this.addCommand({
      id: "show-all-annotations",
      name: "Show all annotations",
      callback: () => { void this.setVisible(true) },
    })
    this.addCommand({
      id: "remove-all-annotations",
      name: "Remove all annotations",
      callback: () => {
        new ConfirmRemoveAllModal(this.app, this.data.annotations.length, () => {
          void this.removeAllAnnotations()
        }).open()
      },
    })
  }

  onunload(): void {
    this.hidePopover()
  }

  async onExternalSettingsChange(): Promise<void> {
    await this.reloadExternalData()
  }

  private async reloadExternalData(): Promise<void> {
    await this.pendingSave
    const latest = parseHighlightData(await this.loadData())
    if (JSON.stringify(latest) === JSON.stringify(this.data)) return
    this.data = latest
    this.hidePopover()
    this.refreshEditors()
  }

  get mode(): HighlightData["mode"] {
    return this.data.mode
  }

  get visible(): boolean {
    return this.data.visible
  }

  async setMode(mode: HighlightData["mode"]): Promise<void> {
    await this.updateData((data) => ({ ...data, mode }))
    new Notice(`Highlight mode: ${mode === "overlay" ? "Annotations" : "Markdown"}`)
  }

  async setVisible(visible: boolean): Promise<void> {
    await this.updateData((data) => ({ ...data, visible }))
    new Notice(visible ? "Annotations shown." : "Annotations hidden.")
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

  private async addAnnotation(path: string, contents: string, offset: number, quote: string, comment = "", suggestion?: string): Promise<void> {
    try {
      if (suggestion === quote) throw new Error("The replacement is identical to the selected text.")
      const annotation = createAnnotation(path, contents, offset, quote, comment, suggestion)
      if (locateAnnotation(contents, annotation) !== offset) {
        throw new Error("This selection cannot be anchored uniquely. Select a longer passage.")
      }
      await this.updateData((data) => {
        const existing = data.annotations.find((current) => current.path === path && current.quote === quote && locateAnnotation(contents, current) === offset)
        if (existing) {
          if (!comment && suggestion === undefined) throw new Error("That selection already has an annotation.")
          return {
            ...data,
            annotations: data.annotations.map((current) => current.id === existing.id ? {
              ...current,
              comment: comment || current.comment,
              ...(suggestion === undefined ? {} : { suggestion }),
            } : current),
          }
        }
        return { ...data, annotations: [...data.annotations, annotation] }
      })
      new Notice(suggestion !== undefined ? "Suggested edit saved." : comment ? "Comment saved." : "Annotation highlight added.")
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

  private async applySuggestion(id: string): Promise<void> {
    try {
      await this.pendingSave
      const annotation = this.data.annotations.find((item) => item.id === id)
      if (!annotation || annotation.suggestion === undefined) throw new Error("This suggestion is no longer available.")
      const file = this.app.vault.getAbstractFileByPath(annotation.path)
      if (!(file instanceof TFile)) throw new Error("The note is no longer available.")

      let openView: MarkdownView | null = null
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === annotation.path && leaf.view.getMode() === "source") {
          openView = leaf.view
          break
        }
      }
      if (openView) {
        const editor = openView.editor
        const offset = locateAnnotation(editor.getValue(), annotation)
        if (offset === null) throw new Error("The selected text changed or is ambiguous. Review the note before applying.")
        editor.replaceRange(annotation.suggestion, editor.offsetToPos(offset), editor.offsetToPos(offset + annotation.quote.length))
      } else {
        await this.app.vault.process(file, (contents) => {
          const offset = locateAnnotation(contents, annotation)
          if (offset === null) throw new Error("The selected text changed or is ambiguous. Review the note before applying.")
          return `${contents.slice(0, offset)}${annotation.suggestion}${contents.slice(offset + annotation.quote.length)}`
        })
      }
      await this.updateData((data) => ({ ...data, annotations: data.annotations.filter((item) => item.id !== id) }))
      new Notice("Suggestion applied.")
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error))
    }
  }

  private async removeAllAnnotations(): Promise<void> {
    await this.updateData((data) => ({ ...data, annotations: [] }))
    new Notice("All annotations removed.")
  }

  private updateData(change: (data: HighlightData) => HighlightData): Promise<void> {
    const result = this.pendingSave.then(async () => {
      const updated = change(parseHighlightData(await this.loadData()))
      await this.saveData(updated)
      this.data = updated
      this.hidePopover()
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
        if (!owner.data.visible) return Decoration.none
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
      attributes: { "data-annotation-id": annotation.id },
    }).range(from, from + annotation.quote.length)
  }

  private onMouseOver(event: MouseEvent): void {
    if (!this.data.visible || !(event.target instanceof Element)) return
    if (this.popover?.contains(event.target)) {
      this.cancelPopoverHide()
      return
    }
    const mark = event.target.closest<HTMLElement>(".ai-highlight-annotation")
    if (!mark) return
    this.cancelPopoverHide()
    const id = mark.dataset.annotationId
    if (!id || id === this.popoverAnnotationId) return
    const annotation = this.data.annotations.find((item) => item.id === id)
    if (!annotation || (!annotation.comment && annotation.suggestion === undefined)) return
    this.showPopover(mark, annotation)
  }

  private onMouseOut(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return
    const mark = event.target.closest<HTMLElement>(".ai-highlight-annotation")
    const card = this.popover?.contains(event.target) ? this.popover : null
    if (!mark && !card) return
    if (event.relatedTarget instanceof Node && (mark?.contains(event.relatedTarget) || card?.contains(event.relatedTarget))) return
    this.cancelPopoverHide()
    this.popoverHideTimer = window.setTimeout(() => this.hidePopover(), 150)
  }

  private showPopover(mark: HTMLElement, annotation: Annotation): void {
    this.hidePopover()
    const card = document.createElement("div")
    card.className = "ai-highlight-comment-card"
    card.setAttribute("role", "dialog")
    card.setAttribute("aria-label", "Annotation comment")
    if (annotation.comment) {
      const comment = document.createElement("div")
      comment.className = "ai-highlight-comment-text"
      comment.textContent = annotation.comment
      card.append(comment)
    }
    if (annotation.suggestion !== undefined) {
      appendSuggestionDiff(card, annotation)
    }
    const actions = document.createElement("div")
    actions.className = "ai-highlight-comment-actions"
    if (annotation.suggestion !== undefined) {
      const apply = document.createElement("button")
      apply.type = "button"
      apply.textContent = "Apply suggestion"
      apply.addEventListener("click", () => { void this.applySuggestion(annotation.id) })
      actions.append(apply)
    }
    const remove = document.createElement("button")
    remove.type = "button"
    remove.textContent = "Remove annotation"
    remove.addEventListener("click", () => { void this.removeAnnotation(annotation.id) })
    actions.append(remove)
    card.append(actions)
    document.body.append(card)
    const rect = mark.getBoundingClientRect()
    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - card.offsetWidth - 8))}px`
    card.style.top = `${rect.bottom + card.offsetHeight + 8 > window.innerHeight ? Math.max(8, rect.top - card.offsetHeight - 8) : rect.bottom + 8}px`
    this.popover = card
    this.popoverAnnotationId = annotation.id
  }

  private hidePopover(): void {
    this.cancelPopoverHide()
    this.popover?.remove()
    this.popover = null
    this.popoverAnnotationId = null
  }

  private cancelPopoverHide(): void {
    if (this.popoverHideTimer === null) return
    window.clearTimeout(this.popoverHideTimer)
    this.popoverHideTimer = null
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
    new Setting(this.containerEl)
      .setName("Show annotations")
      .setDesc("Hide overlay highlights and comment cards without deleting them.")
      .addToggle((toggle) => toggle
        .setValue(this.owner.visible)
        .onChange((value) => { void this.owner.setVisible(value) }))
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

class SuggestionModal extends Modal {
  constructor(app: App, private readonly submit: (suggestion: string, comment: string) => void) {
    super(app)
  }
  onOpen(): void {
    this.setTitle("Suggest edit for selection")
    let suggestion: string | null = null
    let comment = ""
    new Setting(this.contentEl)
      .setName("Replacement text")
      .setDesc("Leave the field empty to suggest deleting the selection.")
      .addTextArea((input) => input
        .setPlaceholder("Replacement text")
        .onChange((value) => { suggestion = value }))
    new Setting(this.contentEl)
      .setName("Comment")
      .addTextArea((input) => input
        .setPlaceholder("Why this change?")
        .onChange((value) => { comment = value }))
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText("Add suggestion")
      .setCta()
      .onClick(() => {
        this.close()
        this.submit(suggestion ?? "", comment.trim())
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
    private readonly apply: (id: string) => void,
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
      const setting = new Setting(this.contentEl)
        .setName(annotation.quote.slice(0, 100))
        .setDesc(annotation.comment || (annotation.suggestion === undefined ? "Highlight" : "Suggested edit"))
      if (annotation.suggestion !== undefined) {
        setting.addButton((button) => button.setButtonText("Apply").onClick(() => {
          this.apply(annotation.id)
          this.close()
        }))
      }
      setting.addButton((button) => button
        .setButtonText("Remove")
        .onClick(() => {
          this.remove(annotation.id)
          this.close()
        }))
      if (annotation.suggestion !== undefined) appendSuggestionDiff(this.contentEl, annotation)
    }
  }
  onClose(): void {
    this.contentEl.empty()
  }
}

function appendSuggestionDiff(parent: HTMLElement, annotation: Annotation): void {
  if (annotation.suggestion === undefined) return
  const diff = document.createElement("div")
  diff.className = "ai-highlight-diff"
  diff.setAttribute("aria-label", "Suggested edit")
  for (const line of annotation.quote.split("\n")) {
    const removed = document.createElement("div")
    removed.className = "ai-highlight-diff-removed"
    removed.textContent = `- ${line}`
    diff.append(removed)
  }
  for (const line of annotation.suggestion.split("\n")) {
    const added = document.createElement("div")
    added.className = "ai-highlight-diff-added"
    added.textContent = `+ ${line}`
    diff.append(added)
  }
  parent.append(diff)
}

class ConfirmRemoveAllModal extends Modal {
  constructor(app: App, private readonly count: number, private readonly confirm: () => void) {
    super(app)
  }
  onOpen(): void {
    this.setTitle("Remove all annotations?")
    this.contentEl.createEl("p", {
      text: `This will delete all ${this.count} saved annotations and comments from this vault. The Markdown notes will stay unchanged.`,
    })
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("Cancel")
        .onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText("Remove all")
        .setWarning()
        .onClick(() => {
          this.close()
          this.confirm()
        }))
  }
  onClose(): void {
    this.contentEl.empty()
  }
}
